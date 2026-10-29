import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type {
  AgentEvent,
  AgentSession,
  ChatSupport,
  AgentQuestion,
  BackgroundTask,
  FileDiff,
  HistoryEntry,
  PermissionOption,
  QuestionAnswers,
  PlanItem,
  RateLimitInfo,
  SessionContext,
  SessionHistory,
  SessionSettingDef,
  SessionSettings,
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
import { blockedResetAt, parseResetTime } from '../session/limit-reset'

// The SDK is ESM-only; load it lazily so the main bundle (CJS) can require this file.
type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')
type Query = ReturnType<SdkModule['query']>
type SDKMessage = import('@anthropic-ai/claude-agent-sdk').SDKMessage
type SDKUserMessage = import('@anthropic-ai/claude-agent-sdk').SDKUserMessage
type PermissionMode = import('@anthropic-ai/claude-agent-sdk').PermissionMode
type PermissionResult = import('@anthropic-ai/claude-agent-sdk').PermissionResult
type PermissionUpdate = import('@anthropic-ai/claude-agent-sdk').PermissionUpdate
type HookInput = import('@anthropic-ai/claude-agent-sdk').HookInput
type ClaudeSettings = import('@anthropic-ai/claude-agent-sdk').Settings
type HookJSONOutput = import('@anthropic-ai/claude-agent-sdk').HookJSONOutput

/** How long a question may wait for the user, in seconds (hooks time out after a minute by default). */
const QUESTION_TIMEOUT_S = 24 * 60 * 60

/**
 * The user's `claude` for the SDK to spawn. On Windows an npm install gives a
 * `claude.cmd` shim, which cannot be spawned directly; the SDK runs the
 * package's `cli.js` with node instead.
 */
function claudeExecutable(): string | undefined {
  const found = resolveExecutable('claude')
  if (!found || process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(found)) return found ?? undefined
  const cli = join(dirname(found), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
  return existsSync(cli) ? cli : undefined
}

let sdkPromise: Promise<SdkModule> | null = null
const loadSdk = (): Promise<SdkModule> => (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'))

/** Mode new sessions start in. */
export const DEFAULT_MODE = 'CLAUDE_DEFAULT_MODE'
/** Old boolean setting: true meant "start in Bypass permissions". */
export const LEGACY_SKIP_PERMISSIONS = 'CLAUDE_SKIP_PERMISSIONS'

const MODES: { id: PermissionMode; label: string }[] = [
  { id: 'default', label: 'Ask before acting' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'plan', label: 'Plan only' },
  { id: 'auto', label: 'Auto' },
  { id: 'bypassPermissions', label: 'Bypass permissions' }
]

export const MODE_OPTIONS = MODES

/** App setting key for the composer's next-message suggestions; the rest are Claude Code settings keys. */
const PROMPT_SUGGESTIONS = 'promptSuggestions'

/** The chat's /config: Claude Code settings applied to this task's session only (the flag layer), never written to files. */
const SESSION_SETTINGS: SessionSettingDef[] = [
  {
    key: 'alwaysThinkingEnabled',
    label: 'Thinking',
    description: 'Let Claude think before answering, on models that support it.',
    type: 'boolean'
  },
  {
    key: 'effortLevel',
    label: 'Effort',
    description: 'How much effort Claude puts into a reply. Max applies to this session only.',
    type: 'select',
    options: [
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Extra high' },
      { id: 'max', label: 'Max' }
    ]
  },
  {
    key: 'outputStyle',
    label: 'Output style',
    description: 'How Claude writes its replies. Custom styles from your Claude config show up once the session runs.',
    type: 'select',
    options: [
      { id: 'default', label: 'Default' },
      { id: 'Explanatory', label: 'Explanatory' },
      { id: 'Learning', label: 'Learning' }
    ]
  },
  {
    key: 'autoCompactEnabled',
    label: 'Auto-compact',
    description: 'Summarize the conversation automatically when the context fills up.',
    type: 'boolean'
  },
  {
    key: 'language',
    label: 'Response language',
    description: 'The language Claude answers in.',
    type: 'text',
    placeholder: 'e.g. russian'
  },
  {
    key: PROMPT_SUGGESTIONS,
    label: 'Suggest next message',
    description: "Claude's guess at your next message, shown in the composer; Tab accepts it.",
    type: 'boolean'
  }
]

/** Session settings as Claude Code flag settings (everything but the app's own keys). */
function flagSettings(settings: SessionSettings | undefined): ClaudeSettings | undefined {
  const flags = Object.fromEntries(Object.entries(settings ?? {}).filter(([k]) => k !== PROMPT_SUGGESTIONS))
  return Object.keys(flags).length ? (flags as ClaudeSettings) : undefined
}

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
  /** An AskUserQuestion prompt rather than a permission decision. */
  question?: boolean
}

/** Readable name for the SDK's task kinds (local_bash, local_agent, local_workflow, …). */
export function taskKind(raw: string | undefined): string {
  if (!raw) return 'task'
  if (/bash|shell/.test(raw)) return 'shell'
  if (/agent/.test(raw)) return 'agent'
  if (/workflow/.test(raw)) return 'workflow'
  if (/monitor/.test(raw)) return 'monitor'
  return raw.replace(/^local_/, '')
}

/** A subagent's notice that it stopped only to wait on its own background work. */
export function isInterimAgentNotice(summary: string | undefined): boolean {
  return Boolean(summary && /has not reported yet|waiting on its own background work/i.test(summary))
}

/** A notice whose summary only says the report came as a separate message. */
export function isHandbackPointer(summary: string | undefined): boolean {
  return Boolean(summary && /report was delivered to you as a message/i.test(summary))
}

/**
 * The report inside a subagent's hand-back: the harness frames it with a
 * preamble ending in "The report follows:" and indents every line of it.
 */
export function handbackReport(body: string): string {
  const marker = body.search(/The report follows:\s*\n/)
  const rest = marker >= 0 ? body.slice(marker).replace(/^The report follows:\s*\n/, '') : body
  const lines = rest.split('\n')
  const indented = lines.filter((l) => l.trim()).every((l) => l.startsWith('  '))
  return (indented ? lines.map((l) => l.slice(2)) : lines).join('\n').trim()
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim().slice(0, 200) ?? ''
}

/** Ended background tasks kept on the list, newest last. */
const MAX_ENDED_TASKS = 5
/** Ended tasks of subagents kept on the list, under their agents. */
const MAX_ENDED_CHILD_TASKS = 20

/** The questions of an AskUserQuestion call, or undefined when the input does not look like one. */
export function toQuestions(input: Record<string, unknown>): AgentQuestion[] | undefined {
  if (!Array.isArray(input.questions)) return undefined
  const questions = (input.questions as Record<string, unknown>[])
    .filter((q) => typeof q?.question === 'string' && Array.isArray(q.options))
    .map((q) => ({
      question: q.question as string,
      header: str(q.header) ?? '',
      multiSelect: q.multiSelect === true,
      options: (q.options as Record<string, unknown>[])
        .filter((o) => typeof o?.label === 'string')
        .map((o) => ({ label: o.label as string, description: str(o.description) }))
    }))
  return questions.length ? questions : undefined
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

  /**
   * The task's own mode, else the default from settings. Passed explicitly:
   * left out, the SDK starts in "default" (ask) unless settings say otherwise.
   */
  private initialMode(): PermissionMode {
    const mode = this.ctx.mode || this.ctx.getSetting(DEFAULT_MODE)
    return MODES.find((m) => m.id === mode)?.id ?? 'auto'
  }

  async start(): Promise<void> {
    const { query } = await loadSdk()
    const executable = claudeExecutable()
    this.query = query({
      prompt: this.input,
      options: {
        cwd: this.ctx.cwd,
        resume: this.ctx.resumeSessionId,
        model: this.ctx.model && this.ctx.model !== 'default' ? this.ctx.model : undefined,
        permissionMode: this.initialMode(),
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        promptSuggestions: true,
        // A one-line "what it is doing" for each subagent card
        agentProgressSummaries: true,
        settings: flagSettings(this.ctx.sessionSettings),
        // Behave like the user's own CLI: CLAUDE.md, settings, custom commands.
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        pathToClaudeCodeExecutable: executable ?? undefined,
        // Background tasks get their own Stop in the UI, so Stop on the turn leaves them running.
        perTaskStopAffordance: true,
        canUseTool: (toolName, toolInput, opts) =>
          // Already answered through the hook below
          toolName === 'AskUserQuestion' && toolInput.answers
            ? Promise.resolve({ behavior: 'allow', updatedInput: toolInput })
            : this.askPermission(toolName, toolInput, opts),
        // Questions go through a hook: canUseTool is skipped in Bypass permissions mode,
        // and the agent would carry on without an answer.
        hooks: {
          PreToolUse: [
            {
              matcher: 'AskUserQuestion',
              timeout: QUESTION_TIMEOUT_S,
              hooks: [(input, toolUseId, { signal }) => this.askQuestions(input, toolUseId, signal)]
            }
          ]
        },
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
        } else if (msg.subtype === 'task_started') {
          const tool = msg.tool_use_id ? this.tools.get(msg.tool_use_id) : undefined
          this.taskInfo.set(msg.task_id, {
            toolCallId: msg.tool_use_id,
            command: tool ? str(tool.input.command) : undefined,
            description: msg.description
          })
        } else if (msg.subtype === 'task_progress') {
          // A subagent at work: its card shows what it is doing
          const toolCallId = msg.tool_use_id ?? this.taskInfo.get(msg.task_id)?.toolCallId
          const call = toolCallId ? this.tools.get(toolCallId) : undefined
          if (toolCallId && (this.backgroundAgents.has(toolCallId) || (call && toolKind(call.name) === 'task'))) {
            this.emit({
              type: 'tool.updated',
              toolCallId,
              progress: {
                toolUses: msg.usage.tool_uses,
                durationMs: msg.usage.duration_ms,
                activity: msg.summary || msg.last_tool_name
              }
            })
          }
        } else if (msg.subtype === 'background_tasks_changed') {
          // The full set of live background tasks: replace, do not merge
          this.running = msg.tasks
            .filter((t) => !t.ambient)
            .map((t) => {
              const info = this.taskInfo.get(t.task_id)
              const toolCallId = info?.toolCallId ?? (this.agentTasks.get(t.task_id) || undefined)
              if (t.subagent_type) this.agentResumed(t.task_id)
              return {
                id: t.task_id,
                type: t.subagent_type ? `agent · ${t.subagent_type}` : taskKind(t.task_type),
                description: t.description || info?.description || '',
                command: info?.command,
                toolCallId,
                status: 'running' as const,
                // A subagent's own shells and monitors are listed under it
                parentId: t.parent_task_id
              }
            })
          this.emitBackground()
        } else if (msg.subtype === 'task_notification' && !msg.ambient) {
          // A subagent that stopped to wait on its own background work is not done yet
          if (isInterimAgentNotice(msg.summary)) return
          const toolCallId = msg.tool_use_id ?? this.taskInfo.get(msg.task_id)?.toolCallId
          // Its report may have come as a hand-back message; the notice then only points at it
          const report = this.agentReports.get(msg.task_id) ?? (isHandbackPointer(msg.summary) ? undefined : msg.summary || undefined)
          if (toolCallId && this.backgroundAgents.delete(toolCallId)) {
            if (msg.usage) this.emit({ type: 'tool.updated', toolCallId, progress: { toolUses: msg.usage.tool_uses, durationMs: msg.usage.duration_ms, activity: undefined } })
            this.emit({ type: 'tool.completed', toolCallId, status: msg.status === 'completed' ? 'ok' : 'error', output: report ?? msg.status })
          }
          const was = this.running.find((t) => t.id === msg.task_id)
          // Foreground tasks also report their end; only background ones are listed
          if (was) this.endBackground(was, msg.status, report)
          this.agentTasks.set(msg.task_id, toolCallId ?? '')
          this.agentEndedAt.set(msg.task_id, Date.now())
          this.taskInfo.delete(msg.task_id)
        }
        return

      case 'stream_event': {
        if (msg.parent_tool_use_id) return
        this.ensureTurn()
        const ev = msg.event
        if (ev.type === 'message_start') {
          this.streamMessageId = ev.message.id
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && this.streamMessageId) {
          this.emit({ type: 'message.delta', messageId: `${this.streamMessageId}:${ev.index}`, text: ev.delta.text })
        }
        return
      }

      case 'assistant': {
        if (msg.error === 'rate_limit') {
          // "You've hit your session limit · resets 10pm (…)": the reset comes with the
          // rate-limit event, else from the message itself.
          const text = msg.message.content.map((b) => (b.type === 'text' ? b.text : '')).join(' ')
          this.emit({ type: 'limit.reached', resetsAt: blockedResetAt([...this.limits.values()]) ?? parseResetTime(text) })
        }
        // Subagent traffic is summarized by its parent Task tool call.
        if (msg.parent_tool_use_id) return
        this.ensureTurn()
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
        // A background subagent's final report, handed back as a message to this session
        if (msg.origin?.kind === 'peer' && msg.origin.senderTaskId && msg.origin.body) {
          // Other messages from a subagent along the way are not its result
          if (/\[Subagent hand-back\]/.test(msg.origin.body)) this.agentHandback(msg.origin.senderTaskId, msg.origin.body)
          return
        }
        if (msg.parent_tool_use_id || typeof msg.message.content === 'string') return
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue
          const tool = this.tools.get(block.tool_use_id)
          const failed = Boolean(block.is_error)
          const output = toolResultText(block.content)
          // The Agent call returns as soon as a background subagent is launched; its card
          // stays running until the subagent reports back (task_notification).
          if (tool && toolKind(tool.name) === 'task' && !failed && /^Async agent launched/i.test(output ?? '')) {
            this.backgroundAgents.add(block.tool_use_id)
            this.emit({ type: 'tool.updated', toolCallId: block.tool_use_id, progress: { background: true } })
            this.tools.delete(block.tool_use_id)
            continue
          }
          this.emit({
            type: 'tool.completed',
            toolCallId: block.tool_use_id,
            status: failed ? 'error' : 'ok',
            output,
            diff: tool && !failed ? toolDiff(tool.name, tool.input) : undefined
          })
          this.tools.delete(block.tool_use_id)
        }
        return
      }

      case 'prompt_suggestion':
        if (this.ctx.sessionSettings?.[PROMPT_SUGGESTIONS] === false) return
        if (msg.suggestion.trim()) this.emit({ type: 'prompt.suggested', text: msg.suggestion.trim() })
        return

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
  /** What task_started said about each task, for the background list. */
  private taskInfo = new Map<string, { toolCallId?: string; command?: string; description: string }>()
  /** Agent calls whose subagent runs in the background: their cards wait for task_notification. */
  private backgroundAgents = new Set<string>()
  /** Reports subagents handed back as messages, by task id. */
  private agentReports = new Map<string, string>()
  /** Agent card of each task that already ended, for a report that comes after its notice. */
  private agentTasks = new Map<string, string>()

  private agentEndedAt = new Map<string, number>()

  /**
   * A subagent that ended while its own background work ran is woken up when
   * that work finishes: its card is running again until the next report.
   */
  private agentResumed(taskId: string): void {
    const toolCallId = this.agentTasks.get(taskId)
    const endedAt = this.agentEndedAt.get(taskId)
    // The set of live tasks may still list it right after its notice
    if (!toolCallId || endedAt === undefined || Date.now() - endedAt < 1500 || this.backgroundAgents.has(toolCallId)) return
    this.agentEndedAt.delete(taskId)
    this.agentReports.delete(taskId)
    this.backgroundAgents.add(toolCallId)
    this.taskInfo.set(taskId, { toolCallId, description: '' })
    this.emit({ type: 'tool.updated', toolCallId, running: true, progress: { background: true, activity: 'Resumed' } })
  }

  private agentHandback(taskId: string, body: string): void {
    const report = handbackReport(body)
    this.agentReports.set(taskId, report)
    const toolCallId = this.taskInfo.get(taskId)?.toolCallId ?? this.agentTasks.get(taskId)
    if (toolCallId) {
      this.backgroundAgents.delete(toolCallId)
      this.emit({ type: 'tool.completed', toolCallId, status: 'ok', output: report })
    }
    const ended = this.ended.find((t) => t.id === taskId)
    if (ended) {
      ended.summary = firstLine(report)
      this.emitBackground()
    }
  }

  private endBackground(task: BackgroundTask, status: BackgroundTask['status'], summary?: string): void {
    this.running = this.running.filter((t) => t.id !== task.id)
    // A task can end more than once (a subagent resumed by a message): keep one row
    const ended = [...this.ended.filter((t) => t.id !== task.id), { ...task, status, summary: summary ? firstLine(summary) : undefined }]
    const own = ended.filter((t) => !t.parentId).slice(-MAX_ENDED_TASKS)
    const children = ended.filter((t) => t.parentId).slice(-MAX_ENDED_CHILD_TASKS)
    this.ended = ended.filter((t) => own.includes(t) || children.includes(t))
    this.emitBackground()
  }
  private running: BackgroundTask[] = []
  private ended: BackgroundTask[] = []

  private emitBackground(): void {
    // A resumed subagent is running again, not also ended
    const ended = this.ended.filter((e) => !this.running.some((r) => r.id === e.id))
    this.emit({ type: 'background.updated', tasks: [...this.running, ...ended] })
  }

  /**
   * The agent can start a turn by itself, e.g. to report on a background task
   * that finished after the user's turn was over. Give it a turn of its own.
   */
  private ensureTurn(): void {
    if (this.currentTurn || !this.query || this.disposed) return
    this.currentTurn = randomUUID()
    this.emit({ type: 'turn.started', turnId: this.currentTurn })
  }

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
    const questions = toolName === 'AskUserQuestion' ? toQuestions(input) : undefined
    const options: PermissionOption[] = questions
      ? [
          { id: 'answer', label: 'Answer', kind: 'allow_once' },
          { id: 'deny', label: 'Skip', kind: 'deny' }
        ]
      : [{ id: 'allow_once', label: 'Allow', kind: 'allow_once' }]
    if (!questions) {
      if (opts.suggestions?.length) options.push({ id: 'allow_always', label: 'Always allow', kind: 'allow_always' })
      options.push({ id: 'deny', label: 'Deny', kind: 'deny' })
    }

    return new Promise<PermissionResult>((resolve) => {
      this.permissions.set(requestId, { resolve, input, suggestions: opts.suggestions, toolUseId: opts.toolUseID, question: !!questions })
      opts.signal.addEventListener('abort', () => {
        if (!this.permissions.delete(requestId)) return
        resolve({ behavior: 'deny', message: 'Aborted' })
        this.emit({ type: 'permission.resolved', requestId, optionId: 'deny' })
      })
      this.emit({
        type: 'permission.requested',
        requestId,
        toolCallId: opts.toolUseID,
        title: questions ? 'Claude has a question' : `${toolName}: ${toolTitle(toolName, input, this.rel)}`,
        detail: questions ? undefined : opts.blockedPath ? this.rel(opts.blockedPath) : opts.decisionReason,
        options,
        questions
      })
    })
  }

  /** Puts an AskUserQuestion call to the user and hands the answers back as the tool's input. */
  private async askQuestions(input: HookInput, toolUseId: string | undefined, signal: AbortSignal): Promise<HookJSONOutput> {
    const toolInput = 'tool_input' in input ? (input.tool_input as Record<string, unknown>) : undefined
    if (!toolInput || !toQuestions(toolInput)) return {}
    const result = await this.askPermission('AskUserQuestion', toolInput, { signal, toolUseID: toolUseId })
    return {
      hookSpecificOutput:
        result.behavior === 'allow'
          ? { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: result.updatedInput }
          : { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.message }
    }
  }

  respondPermission(requestId: string, optionId: string, answers?: QuestionAnswers): void {
    const pending = this.permissions.get(requestId)
    if (!pending) return
    this.permissions.delete(requestId)
    if (optionId === 'deny') {
      pending.resolve({ behavior: 'deny', message: pending.question ? 'The user chose not to answer.' : 'The user denied this action.' })
    } else {
      pending.resolve({
        behavior: 'allow',
        // AskUserQuestion takes the user's choices back through its input
        updatedInput: answers ? { ...pending.input, answers } : pending.input,
        updatedPermissions: optionId === 'allow_always' ? pending.suggestions : undefined
      })
    }
    this.emit({ type: 'permission.resolved', requestId, optionId, answers })
  }

  async send(input: UserInput): Promise<void> {
    if (!this.query) await this.start()
    if (!this.currentTurn) {
      this.currentTurn = randomUUID()
      this.emit({ type: 'turn.started', turnId: this.currentTurn })
      // Ended background tasks have been seen; the user's next message clears them
      if (this.ended.length) {
        this.ended = []
        this.emitBackground()
      }
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

  async applySessionSettings(changes: Record<string, string | boolean | null>): Promise<void> {
    const next = { ...this.ctx.sessionSettings }
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) delete next[k]
      else next[k] = v
    }
    this.ctx.sessionSettings = next
    const flags = Object.fromEntries(Object.entries(changes).filter(([k]) => k !== PROMPT_SUGGESTIONS))
    if (this.query && Object.keys(flags).length) await this.query.applyFlagSettings(flags as Parameters<Query['applyFlagSettings']>[0])
  }

  async sessionSettingOptions(): Promise<Record<string, { id: string; label: string }[]>> {
    if (!this.query) return {}
    const init = await this.query.initializationResult()
    return { outputStyle: init.available_output_styles.map((s) => ({ id: s, label: s === 'default' ? 'Default' : s })) }
  }

  async moveToBackground(toolCallId: string): Promise<boolean> {
    return (await this.query?.backgroundTasks(toolCallId)) ?? false
  }

  async stopBackgroundTask(taskId: string): Promise<void> {
    await this.query?.stopTask(taskId)
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
    const mapper = new ClaudeSession({ taskId: 'import', cwd, getSetting: () => '' })
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
      pathToClaudeCodeExecutable: claudeExecutable(),
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

/**
 * The plan limits behind the CLI's `/usage`, from a session that never sends
 * anything to the model. Null for API-key and cloud-provider logins.
 */
async function readLimits(): Promise<RateLimitInfo[] | null> {
  const { query } = await loadSdk()
  const input = new InputQueue()
  const q = query({
    prompt: input,
    options: {
      cwd: homedir(),
      settingSources: [],
      pathToClaudeCodeExecutable: claudeExecutable(),
      stderr: (data) => console.warn('[relay][claude limits]', data.trimEnd())
    }
  })
  try {
    // Experimental in the SDK; a failure leaves Settings on the last known values
    const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
    if (!usage.rate_limits_available || !usage.rate_limits) return null
    const limits: RateLimitInfo[] = []
    for (const [key, label] of Object.entries(RATE_LIMIT_LABELS)) {
      const w = (usage.rate_limits as Record<string, { utilization: number | null; resets_at: string | null } | null | undefined>)[key]
      if (!w || w.utilization == null) continue
      const used = Math.round(w.utilization)
      limits.push({
        label,
        usedPercent: used,
        resetsAt: w.resets_at ? Date.parse(w.resets_at) : undefined,
        status: used >= 100 ? 'blocked' : used >= 80 ? 'warning' : 'ok'
      })
    }
    return limits
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
    background: true,
    limits: true,
    sessionSettings: SESSION_SETTINGS,
    models: MODELS,
    modes: MODES
  },
  createSession: (ctx) => new ClaudeSession(ctx),
  history: claudeHistory,
  peek,
  readLimits
}
