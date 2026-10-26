export type TaskStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'paused' | 'pending'

/**
 * Agent identifier, matching an `AgentDefinition.id` in `src/main/agents`.
 * Typed loosely on purpose: the authoritative catalog is served at runtime by
 * `window.api.agents.list()`, so adding an agent in main needs no change here.
 */
export type ProcessType = 'claude-code' | 'codex' | 'aider' | 'opencode' | 'generic' | (string & {})

/** Serializable agent description, mirrors `AgentDescriptor` in the main process. */
interface SettingDefBase {
  key: string
  label: string
  description: string
}

export type AgentSettingDef =
  | (SettingDefBase & { type: 'boolean'; default: boolean })
  | (SettingDefBase & { type: 'select'; default: string; options: { id: string; label: string }[] })

export interface AgentDescriptor {
  id: ProcessType
  label: string
  description: string
  color: string
  enabled: boolean
  available: boolean
  supportsSummaries: boolean
  /** Present when the agent can run in chat mode. */
  chat?: ChatCapabilities
  settings: AgentSettingDef[]
}

export interface ChatCapabilities {
  resume: boolean
  interrupt: boolean
  permissions: boolean
  images: boolean
  forkFromTurn?: boolean
  /** Running commands and subagents can be sent to the background, and background tasks stopped. */
  background?: boolean
  models?: { id: string; label: string }[]
  modes?: { id: string; label: string }[]
}

/** Work the agent left running in the background; mirrors `BackgroundTask` in the main process. */
export interface BackgroundTask {
  id: string
  type: string
  description: string
  command?: string
  toolCallId?: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  summary?: string
}

export interface Project {
  id: string
  name: string
  path: string
  description?: string
  created_at: number
  updated_at: number
}

export interface Task {
  id: string
  project_id: string
  project_name: string
  project_path: string
  worktree_path?: string
  title: string
  prompt: string
  process_type: ProcessType
  status: TaskStatus
  branch?: string
  started_at?: number
  completed_at?: number
  updated_at: number
  created_at: number
  runtime_seconds: number
  changed_files_count: number
  notes?: string
  summary?: string
  /** 1 when pinned to the top of the sidebar (SQLite has no booleans). */
  starred?: number
  metadata?: string
  /** The agent's own session handle, used to resume the conversation. */
  agent_session_id?: string
  transport?: 'chat'
  model?: string | null
  mode?: string | null
  /** Chat tasks: the agent's latest reply, for the dashboard card. */
  last_message?: string | null
  /** Chat tasks: JSON of a permission request still waiting for an answer. */
  pending_permission?: string | null
}

export interface TaskEvent {
  id: string
  task_id: string
  type: 'user_prompt' | 'ai_response' | 'file_change' | 'git_snapshot' | 'system' | 'error' | 'git_merge' | 'turn_completed'
  content?: string
  timestamp: number
  metadata?: string
}

export interface TerminalLog {
  id: number
  task_id: string
  data: string
  timestamp: number
}

export interface FileChange {
  path: string
  type: 'modified' | 'added' | 'deleted' | 'renamed'
  additions?: number
  deletions?: number
}

/**
 * Static fallbacks used before the agent catalog is fetched (and in browser /
 * mock mode). The catalog from `window.api.agents.list()` always wins.
 */
export const PROCESS_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  aider: 'Aider',
  opencode: 'OpenCode',
  generic: 'CLI Tool'
}

export const PROCESS_COLORS: Record<string, string> = {
  'claude-code': '#f97316',
  codex: '#10b981',
  aider: '#8b5cf6',
  opencode: '#06b6d4',
  generic: '#6b7280'
}

/** Label for an agent id — falls back to the raw id for unknown agents. */
export function processLabel(id: ProcessType, agents: AgentDescriptor[] = []): string {
  return agents.find((a) => a.id === id)?.label ?? PROCESS_LABELS[id] ?? id
}

/** Accent color for an agent id — falls back to a neutral gray. */
export function processColor(id: ProcessType, agents: AgentDescriptor[] = []): string {
  return agents.find((a) => a.id === id)?.color ?? PROCESS_COLORS[id] ?? '#6b7280'
}

export const STATUS_CONFIG: Record<
  TaskStatus,
  { label: string; color: string; bg: string; dot: string }
> = {
  running: {
    label: 'Running',
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10',
    dot: 'bg-emerald-400'
  },
  waiting: {
    label: 'Waiting',
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    dot: 'bg-amber-400'
  },
  completed: {
    label: 'Completed',
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    dot: 'bg-blue-400'
  },
  failed: {
    label: 'Failed',
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    dot: 'bg-red-400'
  },
  paused: {
    label: 'Paused',
    color: 'text-zinc-400',
    bg: 'bg-zinc-400/10',
    dot: 'bg-zinc-400'
  },
  pending: {
    label: 'Pending',
    color: 'text-zinc-400',
    bg: 'bg-zinc-400/10',
    dot: 'bg-zinc-500'
  }
}


// --- Chat mode ---------------------------------------------------------------
// Mirrors src/main/agents/adapter.ts and the messages table in src/main/db.

export type ToolKind = 'read' | 'edit' | 'write' | 'bash' | 'search' | 'fetch' | 'todo' | 'task' | 'mcp' | 'other'

export interface FileDiff {
  path: string
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

export interface ChatMessage {
  id: string
  task_id: string
  turn_id: string | null
  seq: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  kind: 'text' | 'thinking' | 'tool_call' | 'permission' | 'plan' | 'error' | 'handoff'
  content: string | null
  tool_call_id: string | null
  tool_status: string | null
  /** JSON array of `{ id, mediaType }` — images attached to a user message. */
  attachments?: string | null
  created_at: number
  updated_at: number
}

export interface ToolCallContent {
  kind: ToolKind
  name: string
  title: string
  input: Record<string, unknown>
  output?: string
  diff?: FileDiff[]
}

/** A multiple-choice question from the agent, mirrors `AgentQuestion` in the main process. */
export interface AgentQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description?: string }[]
}

export interface PermissionContent {
  title: string
  detail?: string
  options: PermissionOption[]
  /** The prompt is a set of questions rather than an allow/deny decision. */
  questions?: AgentQuestion[]
  /** What the user answered, keyed by question text. */
  answers?: Record<string, string>
}

/** A command the user can run by typing `/name` in the composer. */
export interface SlashCommandInfo {
  name: string
  description?: string
  hint?: string
}

export interface RateLimitInfo {
  label: string
  usedPercent?: number
  resetsAt?: number
  status?: 'ok' | 'warning' | 'blocked'
}

export interface SessionUsage {
  contextUsed?: number
  contextSize?: number
  costUsd?: number
  limits?: RateLimitInfo[]
}

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
  | { type: 'permission.requested'; requestId: string; toolCallId?: string; title: string; detail?: string; options: PermissionOption[] }
  | { type: 'permission.resolved'; requestId: string; optionId: string }
  | { type: 'plan.updated'; items: PlanItem[] }
  | { type: 'background.updated'; tasks: BackgroundTask[] }
  | {
      type: 'turn.completed'
      turnId: string
      reason: string
      usage?: { costUsd?: number; durationMs?: number; inputTokens?: number; outputTokens?: number }
      checkpoint?: string
    }
  | { type: 'commands.updated'; commands: SlashCommandInfo[] }
  /** A predicted next user message, offered as ghost text in the composer. */
  | { type: 'prompt.suggested'; text: string }
  | { type: 'usage.updated'; usage: SessionUsage }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'session.exited'; code: number | null }
  | { type: 'raw'; payload: unknown }

export interface ChatEventPayload {
  event: AgentEvent
  message?: ChatMessage
}

export interface TurnInfo {
  id: string
  task_id: string
  seq: number
  status: 'running' | 'completed' | 'interrupted' | 'failed'
  commit_before: string | null
  commit_after: string | null
  usage_json: string | null
  checkpoint?: string | null
  started_at: number
  completed_at: number | null
  files: { path: string; oldPath?: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; additions: number; deletions: number }[]
}
