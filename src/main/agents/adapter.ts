/**
 * Chat-mode agent contract.
 *
 * A chat-capable agent is driven through a structured protocol (an SDK, a
 * JSON-RPC server, ACP) instead of a terminal. Every adapter translates its
 * protocol into the normalized `AgentEvent` stream below, so the session
 * manager, the database and the UI never deal with agent-specific shapes.
 */

/** Closed set of tool categories — the UI renders a card per kind. */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'write'
  | 'bash'
  | 'search'
  | 'fetch'
  | 'todo'
  | 'task'
  | 'mcp'
  | 'other'

export interface FileDiff {
  path: string
  /** Unified diff text, when the agent provides one. */
  patch?: string
  oldText?: string
  newText?: string
}

export interface PermissionOption {
  id: string
  label: string
  kind: 'allow_once' | 'allow_always' | 'deny'
}

export interface PlanItem {
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

export interface TurnUsage {
  inputTokens?: number
  outputTokens?: number
  /** Running session total, as reported by the agent. */
  costUsd?: number
  durationMs?: number
}

/** A multiple-choice question the agent asks the user (Claude's AskUserQuestion). */
export interface AgentQuestion {
  question: string
  /** Short chip label, e.g. "Approach". */
  header: string
  multiSelect: boolean
  options: { label: string; description?: string }[]
}

/** Answers keyed by question text; several picks of a multi-select question are comma-separated. */
export type QuestionAnswers = Record<string, string>

/** A command the user can run by typing `/name` in the composer. */
export interface SlashCommandInfo {
  name: string
  description?: string
  /** Placeholder for the arguments, e.g. `<file>`. */
  hint?: string
}

export interface RateLimitInfo {
  /** e.g. "5-hour", "Weekly". */
  label: string
  usedPercent?: number
  /** Milliseconds since epoch. */
  resetsAt?: number
  status?: 'ok' | 'warning' | 'blocked'
}

/** Session-wide usage, as last reported by the agent. */
export interface SessionUsage {
  /** Tokens currently in the context window. */
  contextUsed?: number
  contextSize?: number
  costUsd?: number
  limits?: RateLimitInfo[]
}

export type TurnEndReason = 'end_turn' | 'interrupted' | 'max_tokens' | 'error'

export type AgentEvent =
  | { type: 'session.started'; sessionId: string; model?: string; mode?: string; slashCommands?: string[] }
  | { type: 'turn.started'; turnId: string }
  | { type: 'message.delta'; messageId: string; text: string }
  | { type: 'message.completed'; messageId: string; text: string }
  | { type: 'thinking'; messageId: string; text: string }
  | { type: 'tool.started'; toolCallId: string; kind: ToolKind; name: string; title: string; input: unknown }
  | { type: 'tool.completed'; toolCallId: string; status: 'ok' | 'error'; output?: string; diff?: FileDiff[] }
  /** Details that arrive after the call started (ACP agents refine title and arguments). */
  | { type: 'tool.updated'; toolCallId: string; kind?: ToolKind; title?: string; input?: unknown; diff?: FileDiff[] }
  /** With `questions`, the prompt is a set of choices; it is answered through respondPermission's `answers`. */
  | {
      type: 'permission.requested'
      requestId: string
      toolCallId?: string
      title: string
      detail?: string
      options: PermissionOption[]
      questions?: AgentQuestion[]
    }
  | { type: 'permission.resolved'; requestId: string; optionId: string; answers?: QuestionAnswers }
  | { type: 'plan.updated'; items: PlanItem[] }
  /** `checkpoint` is the agent's own marker for the end of this turn, used to fork from it. */
  | { type: 'turn.completed'; turnId: string; reason: TurnEndReason; usage?: TurnUsage; checkpoint?: string }
  | { type: 'commands.updated'; commands: SlashCommandInfo[] }
  /** A predicted next user message, offered as ghost text in the composer. */
  | { type: 'prompt.suggested'; text: string }
  | { type: 'usage.updated'; usage: SessionUsage }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'session.exited'; code: number | null }
  /** Anything the normalized model has no slot for yet — kept so nothing is lost. */
  | { type: 'raw'; payload: unknown }

export interface UserInput {
  text: string
  /** Base64 images pasted into the composer. */
  images?: { mediaType: string; data: string }[]
}

export interface AgentCapabilities {
  resume: boolean
  interrupt: boolean
  /** The agent can ask before acting, so the UI must show permission prompts. */
  permissions: boolean
  images: boolean
  /** The conversation can be forked at any finished turn (not only the last one). */
  forkFromTurn?: boolean
  models?: { id: string; label: string }[]
  modes?: { id: string; label: string }[]
}

export interface SessionContext {
  taskId: string
  /** The task's worktree (or project directory for non-git projects). */
  cwd: string
  /** The agent's own session id from a previous run, when resuming. */
  resumeSessionId?: string
  model?: string
  mode?: string
  /** Raw app setting, '' when unset. */
  getSetting: (key: string) => string
}

export interface AgentSession {
  /** Spawns the agent. Events flow through `onEvent` from here on. */
  start(): Promise<void>
  /** Starts a new turn. */
  send(input: UserInput): Promise<void>
  interrupt(): Promise<void>
  /** `answers` replies to a prompt that came with questions. */
  respondPermission(requestId: string, optionId: string, answers?: QuestionAnswers): void
  setMode?(mode: string): Promise<void>
  setModel?(model: string): Promise<void>
  dispose(): Promise<void>
  onEvent(cb: (event: AgentEvent) => void): () => void
}

/** A session the user ran with the agent's own CLI or IDE plugin, outside the app. */
export interface ExternalSessionInfo {
  sessionId: string
  title: string
  /** Directory the session ran in. */
  cwd: string
  createdAt?: number
  /** Milliseconds since epoch. */
  updatedAt: number
  gitBranch?: string
}

/** One step of an imported transcript, in order. */
export type HistoryEntry =
  | { type: 'user'; text: string; images?: { mediaType: string; data: string }[] }
  | { type: 'event'; event: AgentEvent }

/** Reading and continuing sessions that were started outside the app. */
export interface SessionHistory {
  list(): Promise<ExternalSessionInfo[]>
  /** The transcript as user messages and normalized agent events. */
  load(sessionId: string, cwd: string): Promise<HistoryEntry[]>
  /**
   * Copies the session so it can continue in another directory without
   * touching the original. `upTo` is a turn's checkpoint: later turns are
   * left out. Returns the id to resume.
   */
  fork(sessionId: string, cwd: string, upTo?: string): Promise<string>
}

/** Chat-mode half of an agent definition. */
export interface ChatSupport {
  capabilities: AgentCapabilities
  createSession: (ctx: SessionContext) => AgentSession
  history?: SessionHistory
  /**
   * What the composer needs before the first message (commands, context
   * fill), read without running a turn. Used when no session is live.
   */
  peek?: (ctx: Pick<SessionContext, 'cwd' | 'resumeSessionId' | 'model'>) => Promise<{ commands?: SlashCommandInfo[]; usage?: SessionUsage }>
}

/** Small event emitter shared by adapters. */
export class EventHub {
  private listeners = new Set<(e: AgentEvent) => void>()

  on(cb: (e: AgentEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  emit(e: AgentEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e)
      } catch (err) {
        console.error('[relay] agent event listener failed:', err)
      }
    }
  }
}
