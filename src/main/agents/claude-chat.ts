import { randomUUID } from 'crypto'
import type {
  AgentEvent,
  AgentSession,
  ChatSupport,
  FileDiff,
  PermissionOption,
  PlanItem,
  SessionContext,
  ToolKind,
  TurnEndReason,
  TurnUsage,
  UserInput
} from './adapter'
import { EventHub } from './adapter'
import { resolveExecutable } from './resolve-executable'

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
function toolTitle(name: string, input: Record<string, unknown>): string {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
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

  constructor(private ctx: SessionContext) {}

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
              title: toolTitle(block.name, input),
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

      case 'result': {
        let reason: TurnEndReason = 'end_turn'
        if (this.interruptRequested) reason = 'interrupted'
        else if (msg.subtype !== 'success' || msg.is_error) reason = 'error'
        else if (msg.stop_reason === 'max_tokens') reason = 'max_tokens'
        if (reason === 'error' && msg.subtype !== 'success') {
          const errors = 'errors' in msg && Array.isArray(msg.errors) ? msg.errors.join('\n') : msg.subtype
          this.emit({ type: 'error', message: errors, fatal: false })
        }
        this.finishTurn(reason, {
          inputTokens: msg.usage?.input_tokens,
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
    this.emit({ type: 'turn.completed', turnId, reason, usage })
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
        title: `${toolName}: ${toolTitle(toolName, input)}`,
        detail: opts.blockedPath ?? opts.decisionReason,
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
    content.push({ type: 'text', text: input.text })
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

  async dispose(): Promise<void> {
    this.disposed = true
    for (const p of this.permissions.values()) p.resolve({ behavior: 'deny', message: 'Session closed' })
    this.permissions.clear()
    this.input.close()
    this.query?.close()
    this.query = null
  }
}

export const claudeChat: ChatSupport = {
  capabilities: {
    resume: true,
    interrupt: true,
    permissions: true,
    images: true,
    models: MODELS,
    modes: MODES
  },
  createSession: (ctx) => new ClaudeSession(ctx)
}
