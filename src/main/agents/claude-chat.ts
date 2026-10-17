import { randomUUID } from 'crypto'
import type {
  AgentEvent,
  AgentSession,
  ChatSupport,
  FileDiff,
  HistoryEntry,
  PermissionOption,
  PlanItem,
  RateLimitInfo,
  SessionContext,
  SessionHistory,
  SessionUsage,
  SlashCommandInfo,
  ToolKind,
  TurnEndReason,
  TurnUsage,
  UserInput
} from './adapter'
import { EventHub } from './adapter'
import { resolveExecutable } from './resolve-executable'
import { relativizer } from './paths'

// The SDK is ESM-only; load it lazily so the main bundle (CJS) can require this file.
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')
type Query = ReturnType<SdkModule['query']>
type SDKMessage = import('@anthropic-ai/claude-agent-sdk').SDKMessage
type SDKUserMessage = import('@anthropic-ai/claude-agent-sdk').SDKUserMessage
type PermissionMode = import('@anthropic-ai/claude-agent-sdk').PermissionMode
type PermissionResult = import('@anthropic-ai/claude-agent-sdk').PermissionResult
type PermissionUpdate = import('@anthropic-ai/claude-agent-sdk').PermissionUpdate

let sdkPromise: Promise<SdkModule> | null = null
const loadSdk = (): Promise<SdkModule> => (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'))

export const SKIP_PERMISSIONS = 'CLAUDE_SKIP_PERMISSIONS'

const MODES: { id: PermissionMode; label: string }[] = [
  { id: 'default', label: 'Ask before acting' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'plan', label: 'Plan only' },
  { id: 'auto', label: 'Auto' },
  { id: 'bypassPermissions', label: 'Bypass permissions' }
]

const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_opus: 'Weekly Opus',
  seven_day_sonnet: 'Weekly Sonnet',
  overage: 'Extra usage'
}

const MODELS = [
  { id: 'default', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' }
]

const TOOL_KINDS: Record<string, ToolKind> = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Bash: 'bash',
  BashOutput: 'bash',
  KillShell: 'bash',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  TodoWrite: 'todo',
  Task: 'task',
  Agent: 'task'
}

function toolKind(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp'
  return TOOL_KINDS[name] ?? 'other'
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** One-line description of a tool call, shown as the card title. */
function toolTitle(name: string, input: Record<string, unknown>, rel: (p: string) => string = (p) => p): string {
  const rawPath = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  const path = rawPath && rel(rawPath)
  switch (toolKind(name)) {
    case 'read':
    case 'edit':
    case 'write':
      return path ?? name
    case 'bash':
      return str(input.description) ?? str(input.command) ?? name
    case 'search':
      return str(input.pattern) ?? path ?? name
    case 'fetch':
      return str(input.url) ?? str(input.query) ?? name
    case 'task':
      return str(input.description) ?? name
    case 'todo':
      return 'Update plan'
    default:
      return name.replace(/^mcp__/, '').replace(/__/g, ' · ')
  }
}

function toolDiff(name: string, input: Record<string, unknown>): FileDiff[] | undefined {
  const path = str(input.file_path)
  if (!path) return undefined
  if (name === 'Edit') return [{ path, oldText: str(input.old_string) ?? '', newText: str(input.new_string) ?? '' }]
  if (name === 'Write') return [{ path, oldText: '', newText: str(input.content) ?? '' }]
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return (input.edits as Record<string, unknown>[]).map((e) => ({
      path,
      oldText: str(e.old_string) ?? '',
      newText: str(e.new_string) ?? ''
    }))
  }
  return undefined
}

function todoPlan(input: Record<string, unknown>): PlanItem[] {
  if (!Array.isArray(input.todos)) return []
  return (input.todos as Record<string, unknown>[]).map((t) => ({
    text: str(t.content) ?? '',
    status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'in_progress' : 'pending'
  }))
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** Async queue feeding user messages into the SDK's streaming-input mode. */
class InputQueue {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false

  push(msg: SDKUserMessage): void {
    this.items.push(msg)
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.items.shift()
      if (next) {
        yield next
        continue
      }
      await new Promise<void>((resolve) => (this.wake = resolve))
      this.wake = null
    }
  }
}

interface PendingPermission {
  resolve: (r: PermissionResult) => void
  input: Record<string, unknown>
  suggestions?: PermissionUpdate[]
  toolUseId?: string
}

class ClaudeSession implements AgentSession {
  private hub = new EventHub()
  private input = new InputQueue()
  private query: Query | null = null
  private currentTurn: string | null = null
  private interruptRequested = false
  private permissions = new Map<string, PendingPermission>()
  private tools = new Map<string, { name: string; input: Record<string, unknown> }>()
  /** Blocks seen per API message, to give each streamed text block a stable id. */
  private blockCounts = new Map<string, number>()
  private disposed = false

  private rel: (p: string) => string

  constructor(private ctx: SessionContext) {
    this.rel = relativizer(ctx.cwd)
  }

  onEvent(cb: (e: AgentEvent) => void): () => void {
    return this.hub.on(cb)
  }

  private emit(e: AgentEvent): void {
    this.hub.emit(e)
  }

  private initialMode(): PermissionMode {
    if (this.ctx.mode && MODES.some((m) => m.id === this.ctx.mode)) return this.ctx.mode as PermissionMode
    return this.ctx.getBool(SKIP_PERMISSIONS, true) ? 'bypassPermissions' : 'default'
  }

  async start(): Promise<void> {
    const { query } = await loadSdk()
    const executable = resolveExecutable('claude')
    this.query = query({
      prompt: this.input,
      options: {
        cwd: this.ctx.cwd,
        resume: this.ctx.resumeSessionId,
        model: this.ctx.model && this.ctx.model !== 'default' ? this.ctx.model : undefined,
        permissionMode: this.initialMode(),
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        // Behave like the user's own CLI: CLAUDE.md, settings, custom commands.
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        pathToClaudeCodeExecutable: executable ?? undefined,
        canUseTool: (toolName, toolInput, opts) => this.askPermission(toolName, toolInput, opts),
        stderr: (data) => console.warn('[relay][claude]', data.trimEnd())
      }
    })
    void this.consume(this.query)
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.handle(msg)
      this.finishTurn('end_turn')
      this.emit({ type: 'session.exited', code: 0 })
    } catch (err) {
      if (this.disposed) return
      const message = err instanceof Error ? err.message : String(err)
      this.emit({ type: 'error', message, fatal: true })
      this.finishTurn('error')
      this.emit({ type: 'session.exited', code: 1 })
    }
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.emit({
            type: 'session.started',
            sessionId: msg.session_id,
            model: msg.model,
            mode: msg.permissionMode,
            slashCommands: msg.slash_commands
          })
          // The init message has names only; the full list carries descriptions.
          void this.query
            ?.supportedCommands()
            .then((commands) => this.emitCommands(commands))
            .catch(() => {})
        } else if (msg.subtype === 'commands_changed') {
          this.emitCommands(msg.commands)
        }
        return

      case 'stream_event': {
        if (msg.parent_tool_use_id) return
        const ev = msg.event
        if (ev.type === 'message_start') {
          this.streamMessageId = ev.message.id
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && this.streamMessageId) {
          this.emit({ type: 'message.delta', messageId: `${this.streamMessageId}:${ev.index}`, text: ev.delta.text })
        }
        return
      }

      case 'assistant': {
        // Subagent traffic is summarized by its parent Task tool call.
        if (msg.parent_tool_use_id) return
        this.lastAssistantUuid = msg.uuid
        if (msg.message.usage) this.lastUsage = msg.message.usage as unknown as Record<string, number>
        const apiId = msg.message.id
        for (const block of msg.message.content) {
          const index = this.blockCounts.get(apiId) ?? 0
          this.blockCounts.set(apiId, index + 1)
          if (block.type === 'text') {
            this.emit({ type: 'message.completed', messageId: `${apiId}:${index}`, text: block.text })
          } else if (block.type === 'thinking') {
            this.emit({ type: 'thinking', messageId: `${apiId}:${index}`, text: block.thinking })
          } else if (block.type === 'tool_use') {
            const input = (block.input ?? {}) as Record<string, unknown>
            this.tools.set(block.id, { name: block.name, input })
            this.emit({
              type: 'tool.started',
              toolCallId: block.id,
              kind: toolKind(block.name),
              name: block.name,
              title: toolTitle(block.name, input, this.rel),
              input
            })
            if (block.name === 'TodoWrite') this.emit({ type: 'plan.updated', items: todoPlan(input) })
          }
        }
        return
      }

      case 'user': {
        if (msg.parent_tool_use_id || typeof msg.message.content === 'string') return
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue
          const tool = this.tools.get(block.tool_use_id)
          const failed = Boolean(block.is_error)
          this.emit({
            type: 'tool.completed',
            toolCallId: block.tool_use_id,
            status: failed ? 'error' : 'ok',
            output: toolResultText(block.content),
            diff: tool && !failed ? toolDiff(tool.name, tool.input) : undefined
          })
          this.tools.delete(block.tool_use_id)
        }
        return
      }

      case 'rate_limit_event': {
        const info = msg.rate_limit_info
        const label = info.rateLimitType ? RATE_LIMIT_LABELS[info.rateLimitType] ?? info.rateLimitType : 'Usage'
        this.limits.set(label, {
          label,
          usedPercent: info.utilization != null ? Math.round(info.utilization * 100) : undefined,
          resetsAt: info.resetsAt ? info.resetsAt * 1000 : undefined,
          status: info.status === 'rejected' ? 'blocked' : info.status === 'allowed_warning' ? 'warning' : 'ok'
        })
        this.emit({ type: 'usage.updated', usage: { limits: [...this.limits.values()] } })
        return
      }

      case 'result': {
        const windows = Object.values(msg.modelUsage ?? {}).map((u) => u.contextWindow).filter(Boolean)
        const u = this.lastUsage
        this.emit({
          type: 'usage.updated',
          usage: {
            contextUsed: u
              ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
              : undefined,
            contextSize: windows.length ? Math.max(...windows) : undefined,
            costUsd: msg.total_cost_usd,
            limits: this.limits.size ? [...this.limits.values()] : undefined
          }
        })
        let reason: TurnEndReason = 'end_turn'
        if (this.interruptRequested) reason = 'interrupted'
        else if (msg.subtype !== 'success' || msg.is_error) reason = 'error'
        else if (msg.stop_reason === 'max_tokens') reason = 'max_tokens'
        if (reason === 'error' && msg.subtype !== 'success') {
          const errors = 'errors' in msg && Array.isArray(msg.errors) ? msg.errors.join('\n') : msg.subtype
          this.emit({ type: 'error', message: errors, fatal: false })
        }
        this.finishTurn(reason, {
          // Cached prompt tokens are still context the turn used.
          inputTokens:
            msg.usage != null
              ? (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0)
              : undefined,
          outputTokens: msg.usage?.output_tokens,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms
        })
        return
      }

      default:
        return
    }
  }

  private streamMessageId: string | null = null
  /** Last top-level assistant message: the point a fork of this turn continues from. */
  private lastAssistantUuid: string | null = null
  private lastUsage: Record<string, number> | null = null
  private limits = new Map<string, RateLimitInfo>()

  private emitCommands(commands: { name: string; description?: string; argumentHint?: string }[]): void {
    this.emit({ type: 'commands.updated', commands: toCommands(commands) })
  }

  private finishTurn(reason: TurnEndReason, usage?: TurnUsage): void {
    if (!this.currentTurn) return
    const turnId = this.currentTurn
    this.currentTurn = null
    this.interruptRequested = false
    this.blockCounts.clear()
    // Anything still waiting on the user is moot once the turn is over.
    for (const [id, p] of this.permissions) {
      p.resolve({ behavior: 'deny', message: 'Turn ended' })
      this.emit({ type: 'permission.resolved', requestId: id, optionId: 'deny' })
    }
    this.permissions.clear()
    this.emit({ type: 'turn.completed', turnId, reason, usage, checkpoint: this.lastAssistantUuid ?? undefined })
  }

  private askPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: PermissionUpdate[]; toolUseID?: string; blockedPath?: string; decisionReason?: string }
  ): Promise<PermissionResult> {
    const requestId = randomUUID()
    const options: PermissionOption[] = [{ id: 'allow_once', label: 'Allow', kind: 'allow_once' }]
    if (opts.suggestions?.length) options.push({ id: 'allow_always', label: 'Always allow', kind: 'allow_always' })
    options.push({ id: 'deny', label: 'Deny', kind: 'deny' })

    return new Promise<PermissionResult>((resolve) => {
      this.permissions.set(requestId, { resolve, input, suggestions: opts.suggestions, toolUseId: opts.toolUseID })
      opts.signal.addEventListener('abort', () => {
        if (!this.permissions.delete(requestId)) return
        resolve({ behavior: 'deny', message: 'Aborted' })
        this.emit({ type: 'permission.resolved', requestId, optionId: 'deny' })
      })
      this.emit({
        type: 'permission.requested',
        requestId,
        toolCallId: opts.toolUseID,
        title: `${toolName}: ${toolTitle(toolName, input, this.rel)}`,
        detail: opts.blockedPath ? this.rel(opts.blockedPath) : opts.decisionReason,
        options
      })
    })
  }

  respondPermission(requestId: string, optionId: string): void {
    const pending = this.permissions.get(requestId)
    if (!pending) return
    this.permissions.delete(requestId)
    if (optionId === 'deny') {
      pending.resolve({ behavior: 'deny', message: 'The user denied this action.' })
    } else {
      pending.resolve({
        behavior: 'allow',
        updatedInput: pending.input,
        updatedPermissions: optionId === 'allow_always' ? pending.suggestions : undefined
      })
    }
    this.emit({ type: 'permission.resolved', requestId, optionId })
  }

  async send(input: UserInput): Promise<void> {
    if (!this.query) await this.start()
    if (!this.currentTurn) {
      this.currentTurn = randomUUID()
      this.emit({ type: 'turn.started', turnId: this.currentTurn })
    }
    const content: Array<Record<string, unknown>> = []
    for (const img of input.images ?? []) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })
    }
    if (input.text.trim()) content.push({ type: 'text', text: input.text })
    this.input.push({
      type: 'user',
      message: { role: 'user', content: content as never },
      parent_tool_use_id: null
    })
  }

  async interrupt(): Promise<void> {
    if (!this.query || !this.currentTurn) return
    this.interruptRequested = true
    await this.query.interrupt()
  }

  async setMode(mode: string): Promise<void> {
    await this.query?.setPermissionMode(mode as PermissionMode)
  }

  async setModel(model: string): Promise<void> {
    await this.query?.setModel(model === 'default' ? undefined : model)
  }

  /** Feeds a stored transcript message through the live mapping (history import). */
  replay(msg: unknown): void {
    this.handle(msg as SDKMessage)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const p of this.permissions.values()) p.resolve({ behavior: 'deny', message: 'Session closed' })
    this.permissions.clear()
    this.input.close()
    this.query?.close()
    this.query = null
  }
}

/** CLI bookkeeping that is stored as user messages but was never typed by the user. */
function isMetaUserText(text: string): boolean {
  const t = text.trimStart()
  return (
    t.startsWith('<command-') ||
    t.startsWith('<local-command') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('Caveat: The messages below were generated') ||
    t.startsWith('This session is being continued from a previous conversation') ||
    t.startsWith('[Request interrupted by user')
  )
}

const claudeHistory: SessionHistory = {
  async list() {
    const sdk = await loadSdk()
    const sessions = await sdk.listSessions()
    return sessions
      .filter((s) => s.cwd)
      .map((s) => ({
        sessionId: s.sessionId,
        title: s.customTitle || s.summary || s.firstPrompt || 'Untitled session',
        cwd: s.cwd!,
        createdAt: s.createdAt,
        updatedAt: s.lastModified,
        gitBranch: s.gitBranch
      }))
  },

  async load(sessionId, cwd) {
    const sdk = await loadSdk()
    const messages = await sdk.getSessionMessages(sessionId)
    const entries: HistoryEntry[] = []
    const mapper = new ClaudeSession({ taskId: 'import', cwd, getBool: () => false })
    mapper.onEvent((event) => entries.push({ type: 'event', event }))

    for (const m of messages) {
      if (m.parent_tool_use_id) continue
      const message = m.message as { content?: unknown }
      if (m.type === 'assistant') {
        mapper.replay(m)
        continue
      }
      if (m.type !== 'user') continue
      if (typeof message.content === 'string') {
        if (!isMetaUserText(message.content)) entries.push({ type: 'user', text: message.content })
        continue
      }
      if (!Array.isArray(message.content)) continue
      const blocks = message.content as Record<string, unknown>[]
      if (blocks.some((b) => b.type === 'tool_result')) mapper.replay(m)
      const text = blocks
        .filter((b) => b.type === 'text' && typeof b.text === 'string' && !isMetaUserText(b.text as string))
        .map((b) => b.text as string)
        .join('\n\n')
      const images = blocks
        .filter((b) => b.type === 'image')
        .map((b) => b.source as { type?: string; media_type?: string; data?: string })
        .filter((src) => src?.type === 'base64' && src.data)
        .map((src) => ({ mediaType: src.media_type ?? 'image/png', data: src.data! }))
      if (text.trim() || images.length) entries.push({ type: 'user', text, images })
    }
    return entries
  },

  async fork(sessionId, _cwd, upTo) {
    const sdk = await loadSdk()
    return (await sdk.forkSession(sessionId, upTo ? { upToMessageId: upTo } : undefined)).sessionId
  }
}

function toCommands(commands: { name: string; description?: string; argumentHint?: string }[]): SlashCommandInfo[] {
  return commands.map((c) => ({ name: c.name.replace(/^\//, ''), description: c.description || undefined, hint: c.argumentHint || undefined }))
}

/**
 * Opens the session without sending anything: the CLI loads the transcript and
 * settings, which is enough to list commands and measure the context. No
 * request reaches the model.
 */
async function peek(ctx: Pick<SessionContext, 'cwd' | 'resumeSessionId' | 'model'>): Promise<{ commands?: SlashCommandInfo[]; usage?: SessionUsage }> {
  const { query } = await loadSdk()
  const input = new InputQueue()
  const q = query({
    prompt: input,
    options: {
      cwd: ctx.cwd,
      resume: ctx.resumeSessionId,
      model: ctx.model && ctx.model !== 'default' ? ctx.model : undefined,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      pathToClaudeCodeExecutable: resolveExecutable('claude') ?? undefined,
      stderr: (data) => console.warn('[relay][claude peek]', data.trimEnd())
    }
  })
  try {
    const [commands, context] = await Promise.all([
      q.supportedCommands(),
      q.getContextUsage({ detail: 'summary' }).catch(() => null)
    ])
    return {
      commands: toCommands(commands),
      usage: context ? { contextUsed: context.totalTokens, contextSize: context.maxTokens } : undefined
    }
  } finally {
    input.close()
    q.close()
  }
}

export const claudeChat: ChatSupport = {
  capabilities: {
    resume: true,
    interrupt: true,
    permissions: true,
    images: true,
    forkFromTurn: true,
    models: MODELS,
    modes: MODES
  },
  createSession: (ctx) => new ClaudeSession(ctx),
  history: claudeHistory,
  peek
}
