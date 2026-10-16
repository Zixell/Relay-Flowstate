export type TaskStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'paused' | 'pending'

/**
 * Agent identifier, matching an `AgentDefinition.id` in `src/main/agents`.
 * Typed loosely on purpose: the authoritative catalog is served at runtime by
 * `window.api.agents.list()`, so adding an agent in main needs no change here.
 */
export type ProcessType = 'claude-code' | 'codex' | 'aider' | 'opencode' | 'generic' | (string & {})

/** Serializable agent description, mirrors `AgentDescriptor` in the main process. */
export interface AgentSettingDef {
  key: string
  label: string
  description: string
  type: 'boolean'
  default: boolean
}

export interface AgentDescriptor {
  id: ProcessType
  label: string
  description: string
  color: string
  enabled: boolean
  available: boolean
  supportsResume: boolean
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
  models?: { id: string; label: string }[]
  modes?: { id: string; label: string }[]
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
  metadata?: string
  /** The agent's own session handle, used to resume the conversation. */
  agent_session_id?: string
  /** 'chat' = structured agent session, 'pty' = legacy terminal task. */
  transport?: 'pty' | 'chat'
  model?: string | null
  mode?: string | null
}

export interface TaskEvent {
  id: string
  task_id: string
  type: 'user_prompt' | 'ai_response' | 'file_change' | 'git_snapshot' | 'system' | 'error' | 'git_merge'
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
  kind: 'text' | 'thinking' | 'tool_call' | 'permission' | 'plan' | 'error'
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

export interface PermissionContent {
  title: string
  detail?: string
  options: PermissionOption[]
}

export type AgentEvent =
  | { type: 'session.started'; sessionId: string; model?: string; mode?: string; slashCommands?: string[] }
  | { type: 'turn.started'; turnId: string }
  | { type: 'message.delta'; messageId: string; text: string }
  | { type: 'message.completed'; messageId: string; text: string }
  | { type: 'thinking'; messageId: string; text: string }
  | { type: 'tool.started'; toolCallId: string; kind: ToolKind; name: string; title: string; input: unknown }
  | { type: 'tool.completed'; toolCallId: string; status: 'ok' | 'error'; output?: string; diff?: FileDiff[] }
  | { type: 'permission.requested'; requestId: string; toolCallId?: string; title: string; detail?: string; options: PermissionOption[] }
  | { type: 'permission.resolved'; requestId: string; optionId: string }
  | { type: 'plan.updated'; items: PlanItem[] }
  | { type: 'turn.completed'; turnId: string; reason: string; usage?: { costUsd?: number; durationMs?: number; inputTokens?: number; outputTokens?: number } }
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
  started_at: number
  completed_at: number | null
  files: { path: string; oldPath?: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; additions: number; deletions: number }[]
}
