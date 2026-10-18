import { randomUUID } from 'crypto'
import { getAgent } from '../agents'
import {
  getMessages,
  getTaskById,
  getTurn,
  getTurns,
  insertMessage,
  insertTask,
  insertTaskEvent,
  updateTaskAgentSessionId,
  updateTaskStatus,
  type MessageAttachment
} from '../db'
import { addWorktree, checkWorktreeSupport } from '../git/worktree'
import { restoreSnapshot, snapshotWorkingTree } from '../git/snapshots'
import { getCurrentCommit } from '../git'
import { readAttachment, saveAttachment } from './attachments'
import { readHandoff } from './handoff'

interface TaskRow {
  id: string
  title: string
  prompt: string
  project_id: string
  project_path: string
  worktree_path: string | null
  branch: string | null
  process_type: string
  agent_session_id: string | null
  model: string | null
  mode: string | null
  metadata: string | null
}

/**
 * Starts a new task from a finished turn: its own worktree with the files as
 * they were at the end of that turn, and a copy of the conversation up to it.
 * The original task is left untouched.
 */
export async function forkTask(taskId: string, turnId: string): Promise<unknown> {
  const task = getTaskById(taskId) as TaskRow | null
  const turn = getTurn(turnId)
  if (!task || !turn || turn.task_id !== taskId) throw new Error('Turn not found')
  if (turn.status === 'running') throw new Error('Wait for the turn to finish before forking from it')
  if (!turn.commit_after) throw new Error('This turn has no file snapshot to fork from')
  if (!task.agent_session_id) throw new Error('The agent session of this task is unknown')
  // Earlier turns belong to the previous agent's session, which this task no longer has.
  const handoff = readHandoff(task.metadata)
  if (handoff && turn.started_at < handoff.at) throw new Error(`This turn was made by ${handoff.fromLabel}; only turns after the switch can be forked`)

  const agent = getAgent(task.process_type)
  const history = agent.chat?.history
  if (!history) throw new Error(`${agent.label} conversations cannot be forked`)
  const finished = getTurns(taskId).filter((t) => t.status !== 'running')
  const isLast = finished[finished.length - 1]?.id === turnId
  if (!isLast && !(agent.chat?.capabilities.forkFromTurn && turn.checkpoint)) {
    throw new Error(
      agent.chat?.capabilities.forkFromTurn
        ? 'This turn was recorded before forking was supported; fork from the last turn instead'
        : `${agent.label} can only be forked from its last turn`
    )
  }
  const issue = checkWorktreeSupport(task.project_path)
  if (issue) throw new Error(issue === 'not-git' ? 'Forking needs a git repository' : 'Forking needs a repository with at least one commit')

  // The agent copy first: if it fails, nothing has been created yet.
  const sourceCwd = task.worktree_path || task.project_path
  const sessionId = await history.fork(task.agent_session_id, sourceCwd, isLast ? undefined : turn.checkpoint ?? undefined)

  const newId = randomUUID()
  const { worktreePath } = addWorktree(task.project_path, newId)
  const base = snapshotWorkingTree(worktreePath, newId, 'fork-base')
  if (!base || !restoreSnapshot(worktreePath, turn.commit_after, base)) {
    throw new Error('Could not restore the files of that turn into the new worktree')
  }

  const turnNumber = finished.findIndex((t) => t.id === turnId) + 1
  insertTask({
    id: newId,
    project_id: task.project_id,
    title: `${task.title} (fork)`.slice(0, 200),
    prompt: task.prompt,
    process_type: task.process_type,
    branch: task.branch ?? undefined,
    worktree_path: worktreePath,
    metadata: JSON.stringify({ startCommit: getCurrentCommit(worktreePath), forkedFrom: { taskId, turnId } }),
    transport: 'chat',
    model: task.model ?? undefined,
    mode: task.mode ?? undefined
  })
  updateTaskAgentSessionId(newId, sessionId)

  // Copy the transcript through the last message of the forked turn.
  const messages = getMessages(taskId, { limit: 100_000 })
  const cut = Math.max(...messages.filter((m) => m.turn_id === turnId).map((m) => m.seq), -1)
  for (const m of messages) {
    if (cut >= 0 && m.seq > cut) break
    if (m.kind === 'permission' && m.tool_status === 'pending') continue
    let attachments: MessageAttachment[] | undefined
    if (m.attachments) {
      attachments = (JSON.parse(m.attachments) as MessageAttachment[])
        .map((a) => readAttachment(taskId, a.id))
        .filter((url): url is string => Boolean(url))
        .map((url) => saveAttachment(newId, { mediaType: url.slice(5, url.indexOf(';')), data: url.slice(url.indexOf(',') + 1) }))
    }
    insertMessage({
      id: randomUUID(),
      task_id: newId,
      role: m.role,
      kind: m.kind,
      content: m.content,
      tool_call_id: m.tool_call_id,
      tool_status: m.tool_status,
      attachments
    })
  }

  insertTaskEvent({
    id: randomUUID(),
    task_id: newId,
    type: 'system',
    content: `Forked from "${task.title}" at turn ${turnNumber}; files restored to the end of that turn in ${worktreePath}`
  })
  insertTaskEvent({
    id: randomUUID(),
    task_id: taskId,
    type: 'system',
    content: `Forked at turn ${turnNumber} into a new task`
  })
  updateTaskStatus(newId, 'completed')
  return getTaskById(newId)
}
