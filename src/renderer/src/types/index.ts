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
  settings: AgentSettingDef[]
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

