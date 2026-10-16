import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type { AgentEvent, AgentSession, PlanItem, UserInput } from '../agents/adapter'
import { getAgent, getBoolSetting } from '../agents'
import {
  getTaskById,
  updateTaskStatus,
  updateTaskAgentSessionId,
  updateTaskChatSettings,
  insertTaskEvent,
  insertTurn,
  completeTurn,
  getTurn,
  getTurnsRuntimeSeconds,
  insertMessage,
  updateMessage,
  getMessageByToolCall,
  getMessages,
  getTaskSummaries,
  appendTaskSummary,
  type MessageRow
} from '../db'
import { snapshotWorkingTree, diffSnapshotFiles } from '../git/snapshots'
import { generateSessionSummary } from '../summary/generator'
import { initialStatusState, reduceStatus, type StatusState, type TaskStatus } from './status'

interface TaskRow {
  id: string
  process_type: string
  project_path: string
  worktree_path?: string | null
  agent_session_id?: string | null
  status: TaskStatus
  model?: string | null
  mode?: string | null
  metadata?: string | null
}

interface LiveSession {
  taskId: string
  cwd: string
  session: AgentSession
  status: StatusState
  turnId: string | null
  /** Text streamed so far per message — the renderer needs it after a reload. */
  streaming: Map<string, string>
  plan: PlanItem[]
  unsubscribe: () => void
}

/** What the renderer receives on `chat:event:<taskId>`. */
export interface ChatEventPayload {
  event: AgentEvent
  /** The persisted row the event created or updated, if any. */
  message?: MessageRow
}

const MAX_TOOL_OUTPUT = 20_000

const live = new Map<string, LiveSession>()

function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function emitToRenderer(taskId: string, payload: ChatEventPayload): void {
  send(`chat:event:${taskId}`, payload)
}

function setStatus(s: LiveSession, next: StatusState): void {
  const prev = s.status.status
  s.status = next
  if (prev === next.status) return
  updateTaskStatus(s.taskId, next.status, { runtime_seconds: getTurnsRuntimeSeconds(s.taskId) })
  send('task:status', { taskId: s.taskId, status: next.status })
}

function loadTask(taskId: string): TaskRow {
  const task = getTaskById(taskId) as TaskRow | null
  if (!task) throw new Error(`Task ${taskId} not found`)
  return task
}

async function ensureSession(taskId: string): Promise<LiveSession> {
  const existing = live.get(taskId)
  if (existing) return existing

  const task = loadTask(taskId)
  const agent = getAgent(task.process_type)
  if (!agent.chat) throw new Error(`${agent.label} does not support chat mode yet`)

  const cwd = task.worktree_path || task.project_path
  const session = agent.chat.createSession({
    taskId,
    cwd,
    resumeSessionId: task.agent_session_id ?? undefined,
    model: task.model ?? undefined,
    mode: task.mode ?? undefined,
    getBool: getBoolSetting
  })

  const entry: LiveSession = {
    taskId,
    cwd,
    session,
    status: initialStatusState(task.status),
    turnId: null,
    streaming: new Map(),
    plan: [],
    unsubscribe: () => {}
  }
  entry.unsubscribe = session.onEvent((e) => {
    try {
      handleEvent(entry, e)
    } catch (err) {
      console.error('[relay] failed to handle agent event', e.type, err)
    }
  })
  live.set(taskId, entry)

  try {
    await session.start()
  } catch (err) {
    live.delete(taskId)
    entry.unsubscribe()
    throw err
  }
  return entry
}

function handleEvent(s: LiveSession, e: AgentEvent): void {
  const { taskId } = s
  let message: MessageRow | undefined

  switch (e.type) {
    case 'session.started':
      updateTaskAgentSessionId(taskId, e.sessionId)
      if (e.mode) updateTaskChatSettings(taskId, { mode: e.mode })
      break

    case 'turn.started': {
      s.turnId = e.turnId
      const before = snapshotWorkingTree(s.cwd, taskId, `${e.turnId}-before`) ?? undefined
      insertTurn({ id: e.turnId, task_id: taskId, commit_before: before })
      break
    }

    case 'message.delta':
      s.streaming.set(e.messageId, (s.streaming.get(e.messageId) ?? '') + e.text)
      break

    case 'message.completed':
      s.streaming.delete(e.messageId)
      if (e.text.trim()) {
        message = insertMessage({ id: randomUUID(), task_id: taskId, turn_id: s.turnId, role: 'assistant', kind: 'text', content: e.text })
      }
      break

    case 'thinking':
      if (e.text.trim()) {
        message = insertMessage({ id: randomUUID(), task_id: taskId, turn_id: s.turnId, role: 'assistant', kind: 'thinking', content: e.text })
      }
      break

    case 'tool.started':
      message = insertMessage({
        id: randomUUID(),
        task_id: taskId,
        turn_id: s.turnId,
        role: 'tool',
        kind: 'tool_call',
        tool_call_id: e.toolCallId,
        tool_status: 'running',
        content: JSON.stringify({ kind: e.kind, name: e.name, title: e.title, input: e.input })
      })
      break

    case 'tool.completed': {
      const row = getMessageByToolCall(taskId, e.toolCallId)
      if (!row) break
      const content = JSON.parse(row.content ?? '{}')
      content.output = e.output && e.output.length > MAX_TOOL_OUTPUT ? e.output.slice(0, MAX_TOOL_OUTPUT) + '\n…(truncated)' : e.output
      if (e.diff) content.diff = e.diff
      message = updateMessage(row.id, { content: JSON.stringify(content), tool_status: e.status })
      break
    }

    case 'permission.requested':
      message = insertMessage({
        id: e.requestId,
        task_id: taskId,
        turn_id: s.turnId,
        role: 'system',
        kind: 'permission',
        tool_call_id: e.toolCallId,
        tool_status: 'pending',
        content: JSON.stringify({ title: e.title, detail: e.detail, options: e.options })
      })
      break

    case 'permission.resolved':
      message = updateMessage(e.requestId, { tool_status: e.optionId })
      break

    case 'plan.updated':
      s.plan = e.items
      break

    case 'error':
      message = insertMessage({ id: randomUUID(), task_id: taskId, turn_id: s.turnId, role: 'system', kind: 'error', content: e.message })
      break

    case 'turn.completed':
      finishTurn(s, e)
      break

    case 'session.exited':
      setStatus(s, reduceStatus(s.status, e))
      s.unsubscribe()
      live.delete(taskId)
      emitToRenderer(taskId, { event: e })
      return

    default:
      break
  }

  setStatus(s, reduceStatus(s.status, e))
  emitToRenderer(taskId, { event: e, message })
}

function finishTurn(s: LiveSession, e: AgentEvent & { type: 'turn.completed' }): void {
  const { taskId } = s
  s.streaming.clear()
  s.turnId = null

  const turn = getTurn(e.turnId)
  const after = snapshotWorkingTree(s.cwd, taskId, `${e.turnId}-after`) ?? undefined
  const status = e.reason === 'interrupted' ? 'interrupted' : e.reason === 'error' ? 'failed' : 'completed'
  completeTurn(e.turnId, { status, commit_after: after, usage_json: e.usage ? JSON.stringify(e.usage) : undefined })

  const changed = turn?.commit_before && after ? diffSnapshotFiles(s.cwd, turn.commit_before, after) : []
  insertTaskEvent({
    id: randomUUID(),
    task_id: taskId,
    type: 'turn_completed',
    content: changed.length ? `${changed.length} file(s) changed` : 'No file changes',
    metadata: JSON.stringify({ turnId: e.turnId, reason: e.reason, files: changed.map((f) => f.path) })
  })

  if (e.reason === 'end_turn' || e.reason === 'max_tokens') void summarize(taskId, e.turnId)
}

/** Updates the task summary from the turn's transcript instead of terminal output. */
async function summarize(taskId: string, turnId: string): Promise<void> {
  try {
    const task = loadTask(taskId)
    const turnMessages = getMessages(taskId, { limit: 2000 }).filter((m) => m.turn_id === turnId || (m.role === 'user' && !m.turn_id))
    const userPrompts = getMessages(taskId, { limit: 50 })
      .filter((m) => m.role === 'user' && m.kind === 'text' && m.content)
      .slice(-5)
      .map((m) => m.content as string)
    const transcript = turnMessages
      .map((m) => {
        if (m.kind === 'text') return `${m.role}: ${m.content}`
        if (m.kind === 'tool_call') {
          const c = JSON.parse(m.content ?? '{}')
          return `tool ${c.name}: ${c.title} [${m.tool_status}]`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')

    const rows = getTaskSummaries(taskId)
    const existing = rows.length ? (JSON.parse(rows[rows.length - 1].summary_json) as { text?: string }) : null
    const meta = task.metadata ? JSON.parse(task.metadata) : {}

    const summary = await generateSessionSummary({
      taskId,
      agentId: task.process_type,
      userPrompts,
      cwd: task.worktree_path || task.project_path,
      startCommit: meta.startCommit,
      status: 'completed',
      agentOutput: transcript,
      existingSummaryText: existing?.text
    })
    appendTaskSummary(taskId, JSON.stringify(summary))
    send(`pty:summary:${taskId}`, JSON.stringify([summary]))
  } catch (err) {
    console.warn('[relay] chat summary failed:', err)
  }
}

// --- Public API (used by IPC handlers) --------------------------------------

export async function sendMessage(taskId: string, input: UserInput): Promise<MessageRow | undefined> {
  const s = await ensureSession(taskId)
  const message = insertMessage({ id: randomUUID(), task_id: taskId, turn_id: s.turnId, role: 'user', kind: 'text', content: input.text })
  if (message) emitToRenderer(taskId, { event: { type: 'raw', payload: { userMessage: true } }, message })
  await s.session.send(input)
  return message
}

export async function interrupt(taskId: string): Promise<void> {
  await live.get(taskId)?.session.interrupt()
}

export function respondPermission(taskId: string, requestId: string, optionId: string): void {
  live.get(taskId)?.session.respondPermission(requestId, optionId)
}

export async function setMode(taskId: string, mode: string): Promise<void> {
  updateTaskChatSettings(taskId, { mode })
  await live.get(taskId)?.session.setMode?.(mode)
}

export async function setModel(taskId: string, model: string): Promise<void> {
  updateTaskChatSettings(taskId, { model })
  await live.get(taskId)?.session.setModel?.(model)
}

/** Live state that is not in the database: streaming text and the plan. */
export function getLiveState(taskId: string): { active: boolean; streaming: Record<string, string>; plan: PlanItem[] } {
  const s = live.get(taskId)
  return {
    active: Boolean(s),
    streaming: s ? Object.fromEntries(s.streaming) : {},
    plan: s?.plan ?? []
  }
}

export async function disposeSession(taskId: string): Promise<void> {
  const s = live.get(taskId)
  if (!s) return
  live.delete(taskId)
  s.unsubscribe()
  await s.session.dispose()
}

export async function disposeAllSessions(): Promise<void> {
  await Promise.all([...live.keys()].map(disposeSession))
}
