import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import { spawnSync } from 'child_process'
import type { AgentEvent, ExternalSessionInfo, HistoryEntry, PlanItem } from '../agents/adapter'
import { describeAgents, getAgent, isAgentAvailable } from '../agents'
import {
  getMessages,
  getTaskById,
  getTaskSessionLinks,
  insertMessage,
  insertTask,
  insertTaskEvent,
  updateTaskAgentSessionId,
  updateTaskMetadata,
  updateTaskPlan,
  updateTaskStatus,
  upsertProject
} from '../db'
import { addWorktree, checkWorktreeSupport } from '../git/worktree'
import { getCurrentCommit } from '../git'
import { saveAttachment } from './attachments'
import { persistEvent } from './manager'

export interface ImportableSession extends ExternalSessionInfo {
  agentId: string
  agentLabel: string
  /** The task this session was already imported into. */
  importedTaskId?: string
  cwdExists: boolean
  /** Why the session cannot get its own worktree, if it cannot. */
  worktreeIssue: string | null
}

export interface ImportRequest {
  agentId: string
  sessionId: string
  cwd: string
  title: string
  /** Continue in a new worktree on a fork of the session instead of in place. */
  worktree: boolean
}

function currentBranch(cwd: string): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5000 })
  const branch = r.status === 0 ? r.stdout.trim() : ''
  return branch && branch !== 'HEAD' ? branch : undefined
}

/** Sessions run with the agents' own CLIs, newest first. Sessions the app itself started are left out. */
export async function listImportableSessions(): Promise<ImportableSession[]> {
  const worktreesRoot = join(app.getPath('userData'), 'worktrees')
  // Also catches worktrees of another Relay profile (e.g. a dev build).
  const isRelayWorktree = (cwd: string): boolean => cwd.startsWith(worktreesRoot) || /\/relay\/worktrees\/task-[0-9a-f-]+/.test(cwd)
  const ownSessions = new Set<string>()
  const imported = new Map<string, string>()
  for (const t of getTaskSessionLinks()) {
    if (t.agent_session_id) ownSessions.add(t.agent_session_id)
    try {
      const from = t.metadata ? (JSON.parse(t.metadata).importedFrom as { sessionId?: string } | undefined) : undefined
      if (from?.sessionId) imported.set(from.sessionId, t.id)
    } catch {
      // ignore malformed metadata
    }
  }

  const issues = new Map<string, string | null>()
  const worktreeIssue = (cwd: string): string | null => {
    if (!issues.has(cwd)) issues.set(cwd, existsSync(cwd) ? checkWorktreeSupport(cwd) : 'missing')
    return issues.get(cwd)!
  }

  const results = await Promise.all(
    describeAgents()
      .filter((a) => a.available && getAgent(a.id).chat?.history)
      .map(async (a) => {
        try {
          const sessions = await getAgent(a.id).chat!.history!.list()
          return sessions.map((s) => ({ ...s, agentId: a.id, agentLabel: a.label }))
        } catch (err) {
          console.warn(`[relay] could not list ${a.label} sessions:`, err)
          return []
        }
      })
  )

  return results
    .flat()
    .filter((s) => !isRelayWorktree(s.cwd) && (!ownSessions.has(s.sessionId) || imported.has(s.sessionId)))
    .map((s) => ({
      ...s,
      importedTaskId: imported.get(s.sessionId),
      cwdExists: existsSync(s.cwd),
      worktreeIssue: worktreeIssue(s.cwd)
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Stores a transcript read from an agent's session as the task's chat history. */
function writeTranscript(taskId: string, entries: HistoryEntry[]): void {
  const unfinished = new Set<string>()
  let plan: PlanItem[] | null = null
  const record = (event: AgentEvent): void => {
    if (event.type === 'tool.started') unfinished.add(event.toolCallId)
    if (event.type === 'tool.completed') unfinished.delete(event.toolCallId)
    if (event.type === 'plan.updated') plan = event.items
    persistEvent(taskId, null, event)
  }
  for (const entry of entries) {
    if (entry.type === 'event') {
      record(entry.event)
      continue
    }
    const attachments = (entry.images ?? []).map((img) => saveAttachment(taskId, img))
    insertMessage({ id: randomUUID(), task_id: taskId, role: 'user', kind: 'text', content: entry.text, attachments })
  }
  // Calls cut off in the original session (interrupted, crashed) have no result.
  for (const toolCallId of unfinished) record({ type: 'tool.completed', toolCallId, status: 'error', output: 'No result was recorded' })
  if (plan) updateTaskPlan(taskId, plan)
}

const restoring = new Map<string, Promise<void>>()

/**
 * A task from the terminal era gets its chat history from the agent's own
 * session the first time it is opened. Without a session id (or if the agent
 * cannot read it) the original prompt starts the chat instead.
 */
export function restoreLegacyHistory(taskId: string): Promise<void> {
  const task = getTaskById(taskId) as {
    process_type: string
    prompt: string
    project_path: string
    worktree_path: string | null
    agent_session_id: string | null
    metadata: string | null
  } | null
  if (!task) return Promise.resolve()
  let meta: Record<string, unknown> = {}
  try {
    meta = task.metadata ? JSON.parse(task.metadata) : {}
  } catch {
    // treat as empty
  }
  if (!meta.legacyHistory) return Promise.resolve()

  let pending = restoring.get(taskId)
  if (!pending) {
    pending = (async () => {
      const history = getAgent(task.process_type).chat?.history
      let restored = false
      if (history && task.agent_session_id && getMessages(taskId, { limit: 1 }).length === 0) {
        try {
          writeTranscript(taskId, await history.load(task.agent_session_id, task.worktree_path || task.project_path))
          restored = getMessages(taskId, { limit: 1 }).length > 0
        } catch (err) {
          console.warn(`[relay] could not read the history of task ${taskId}:`, err)
        }
      }
      if (!restored && getMessages(taskId, { limit: 1 }).length === 0 && task.prompt) {
        insertMessage({ id: randomUUID(), task_id: taskId, role: 'user', kind: 'text', content: task.prompt })
      }
      delete meta.legacyHistory
      updateTaskMetadata(taskId, meta)
    })().finally(() => restoring.delete(taskId))
    restoring.set(taskId, pending)
  }
  return pending
}

/** Creates a chat task from an external session, with its transcript, ready to continue. */
export async function importSession(req: ImportRequest): Promise<unknown> {
  const agent = getAgent(req.agentId)
  const history = agent.chat?.history
  if (!history || !isAgentAvailable(agent.id)) throw new Error(`${agent.label} sessions cannot be imported`)
  if (!existsSync(req.cwd)) throw new Error(`The session's directory no longer exists: ${req.cwd}`)
  if (req.worktree) {
    const issue = checkWorktreeSupport(req.cwd)
    if (issue) throw new Error(issue === 'not-git' ? 'The project is not a git repository' : 'The repository has no commits yet')
  }

  // Read everything before touching the database, so a failure leaves nothing behind.
  const entries = await history.load(req.sessionId, req.cwd)
  const resumeId = req.worktree ? await history.fork(req.sessionId, req.cwd) : req.sessionId

  const taskId = randomUUID()
  const project = upsertProject({ id: randomUUID(), name: basename(req.cwd), path: req.cwd })
  if (!project) throw new Error('Database is not available')

  let worktreePath: string | undefined
  if (req.worktree) worktreePath = addWorktree(req.cwd, taskId).worktreePath
  const cwd = worktreePath ?? req.cwd

  const firstPrompt = entries.find((e) => e.type === 'user' && e.text.trim())
  insertTask({
    id: taskId,
    project_id: project.id,
    title: req.title.slice(0, 200),
    prompt: firstPrompt && firstPrompt.type === 'user' ? firstPrompt.text : req.title,
    process_type: agent.id,
    branch: req.worktree ? currentBranch(req.cwd) : undefined,
    worktree_path: worktreePath,
    metadata: JSON.stringify({ startCommit: getCurrentCommit(cwd), importedFrom: { agent: agent.id, sessionId: req.sessionId } }),
    transport: 'chat'
  })
  updateTaskAgentSessionId(taskId, resumeId)

  writeTranscript(taskId, entries)

  insertTaskEvent({
    id: randomUUID(),
    task_id: taskId,
    type: 'system',
    content: req.worktree
      ? `Imported a ${agent.label} session (${req.sessionId}) as a copy that continues in worktree ${worktreePath}`
      : `Imported a ${agent.label} session (${req.sessionId}); it continues in ${req.cwd}`
  })
  updateTaskStatus(taskId, 'completed')
  return getTaskById(taskId)
}
