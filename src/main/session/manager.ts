import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { AgentEvent, AgentSession, PlanItem, SessionUsage, SlashCommandInfo, UserInput } from '../agents/adapter'
import { getAgent, getBoolSetting, isAgentAvailable } from '../agents'
import { buildHandoffContext, readHandoff, type HandoffInfo } from './handoff'
import {
  getTaskById,
  updateTaskStatus,
  updateTaskAgentSessionId,
  updateTaskChatSettings,
  updateTaskPlan,
  updateTaskMetadata,
  switchTaskAgent,
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
import { getGitChanges } from '../git'
import { saveAttachment } from './attachments'
import { initialStatusState, reduceStatus, type StatusState, type TaskStatus } from './status'
import { notifyTask, setAttentionCount } from '../notifications'

interface TaskRow {
  id: string
  title: string
  process_type: string
  project_path: string
  worktree_path?: string | null
  agent_session_id?: string | null
  status: TaskStatus
  model?: string | null
  mode?: string | null
  metadata?: string | null
  plan_json?: string | null
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
  commands: SlashCommandInfo[]
  /** Last reply text, for the "finished" notification. */
  lastText: string
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
/**
 * Slash commands last reported per agent, so the composer can offer them
 * before a session starts. Kept on disk across restarts.
 */
const commandsByAgent = new Map<string, SlashCommandInfo[]>()
let commandsLoaded = false
const commandsFile = (): string => join(app.getPath('userData'), 'agent-commands.json')

function agentCommands(agentId: string): SlashCommandInfo[] {
  if (!commandsLoaded) {
    commandsLoaded = true
    try {
      for (const [id, list] of Object.entries(JSON.parse(readFileSync(commandsFile(), 'utf8')))) commandsByAgent.set(id, list as SlashCommandInfo[])
    } catch {
      // first run
    }
  }
  return commandsByAgent.get(agentId) ?? []
}

function rememberCommands(agentId: string, commands: SlashCommandInfo[]): void {
  agentCommands(agentId)
  commandsByAgent.set(agentId, commands)
  try {
    writeFileSync(commandsFile(), JSON.stringify(Object.fromEntries(commandsByAgent)))
  } catch (err) {
    console.warn('[relay] could not save agent commands:', err)
  }
}
/** Usage last reported per task (context, cost, limits); kept after the session ends. */
const usageByTask = new Map<string, SessionUsage>()

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
  setAttentionCount([...live.values()].filter((x) => x.status.status === 'waiting').length)
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
    plan: storedPlan(task),
    commands: agentCommands(task.process_type),
    lastText: '',
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

/**
 * Writes what an event adds to the transcript. Shared by live sessions and by
 * history imported from sessions run outside the app.
 */
export function persistEvent(taskId: string, turnId: string | null, e: AgentEvent): MessageRow | undefined {
  switch (e.type) {
    case 'message.completed':
      if (!e.text.trim()) return undefined
      return insertMessage({ id: randomUUID(), task_id: taskId, turn_id: turnId, role: 'assistant', kind: 'text', content: e.text })

    case 'thinking':
      if (!e.text.trim()) return undefined
      return insertMessage({ id: randomUUID(), task_id: taskId, turn_id: turnId, role: 'assistant', kind: 'thinking', content: e.text })

    case 'tool.started':
      return insertMessage({
        id: randomUUID(),
        task_id: taskId,
        turn_id: turnId,
        role: 'tool',
        kind: 'tool_call',
        tool_call_id: e.toolCallId,
        tool_status: 'running',
        content: JSON.stringify({ kind: e.kind, name: e.name, title: e.title, input: e.input })
      })

    case 'tool.completed': {
      const row = getMessageByToolCall(taskId, e.toolCallId)
      if (!row) return undefined
      const content = JSON.parse(row.content ?? '{}')
      content.output = e.output && e.output.length > MAX_TOOL_OUTPUT ? e.output.slice(0, MAX_TOOL_OUTPUT) + '\n…(truncated)' : e.output
      if (e.diff) content.diff = e.diff
      return updateMessage(row.id, { content: JSON.stringify(content), tool_status: e.status })
    }

    case 'tool.updated': {
      const row = getMessageByToolCall(taskId, e.toolCallId)
      if (!row) return undefined
      const content = JSON.parse(row.content ?? '{}')
      if (e.kind) content.kind = e.kind
      if (e.title) content.title = e.title
      if (e.input !== undefined) content.input = e.input
      if (e.diff) content.diff = e.diff
      return updateMessage(row.id, { content: JSON.stringify(content) })
    }

    case 'permission.requested':
      return insertMessage({
        id: e.requestId,
        task_id: taskId,
        turn_id: turnId,
        role: 'system',
        kind: 'permission',
        tool_call_id: e.toolCallId,
        tool_status: 'pending',
        content: JSON.stringify({ title: e.title, detail: e.detail, options: e.options })
      })

    case 'permission.resolved':
      return updateMessage(e.requestId, { tool_status: e.optionId })

    case 'error':
      return insertMessage({ id: randomUUID(), task_id: taskId, turn_id: turnId, role: 'system', kind: 'error', content: e.message })

    default:
      return undefined
  }
}

function handleEvent(s: LiveSession, e: AgentEvent): void {
  const { taskId } = s

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
      if (e.text.trim()) s.lastText = e.text
      break

    case 'commands.updated': {
      s.commands = e.commands
      rememberCommands(loadTask(taskId).process_type, e.commands)
      break
    }

    case 'usage.updated': {
      const prev = usageByTask.get(taskId) ?? {}
      // Agents report pieces at different times; keep what a partial update leaves out.
      const next: SessionUsage = { ...prev }
      for (const [k, v] of Object.entries(e.usage)) if (v !== undefined) (next as Record<string, unknown>)[k] = v
      usageByTask.set(taskId, next)
      break
    }

    case 'permission.requested':
      notifyTask(taskId, `${loadTask(taskId).title} needs approval`, e.title)
      break

    case 'plan.updated':
      s.plan = e.items
      updateTaskPlan(taskId, e.items)
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

  const message = persistEvent(taskId, s.turnId, e)
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
  completeTurn(e.turnId, { status, commit_after: after, usage_json: e.usage ? JSON.stringify(e.usage) : undefined, checkpoint: e.checkpoint })

  const changed = turn?.commit_before && after ? diffSnapshotFiles(s.cwd, turn.commit_before, after) : []
  if (e.reason !== 'interrupted') {
    const title = loadTask(taskId).title
    notifyTask(
      taskId,
      e.reason === 'error' ? `${title} failed` : `${title} finished`,
      s.lastText.replace(/\s+/g, ' ').trim() || (changed.length ? `${changed.length} file(s) changed` : 'Done')
    )
  }
  insertTaskEvent({
    id: randomUUID(),
    task_id: taskId,
    type: 'turn_completed',
    content: changed.length ? `${changed.length} file(s) changed` : 'No file changes',
    metadata: JSON.stringify({ turnId: e.turnId, reason: e.reason, files: changed.map((f) => f.path) })
  })

  // Same scope as the Files tab: everything since the task started.
  try {
    const task = loadTask(taskId)
    const meta = task.metadata ? JSON.parse(task.metadata) : {}
    const count = getGitChanges(s.cwd, undefined, meta.startCommit).files.length
    updateTaskStatus(taskId, s.status.status, { changed_files_count: count })
    send('task:status', { taskId, status: s.status.status, changedFilesCount: count })
  } catch (err) {
    console.warn('[relay] could not count changed files:', err)
  }

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
    send(`task:summary:${taskId}`, JSON.stringify([summary]))
  } catch (err) {
    console.warn('[relay] chat summary failed:', err)
  }
}

// --- Public API (used by IPC handlers) --------------------------------------

export async function sendMessage(taskId: string, input: UserInput): Promise<MessageRow | undefined> {
  const s = await ensureSession(taskId)
  const attachments = (input.images ?? []).map((img) => saveAttachment(taskId, img))
  const message = insertMessage({
    id: randomUUID(),
    task_id: taskId,
    turn_id: s.turnId,
    role: 'user',
    kind: 'text',
    content: input.text,
    attachments
  })
  if (message) emitToRenderer(taskId, { event: { type: 'raw', payload: { userMessage: true } }, message })

  // First message to an agent that took the task over: it gets the story so far
  // in front of it. The chat shows only what the user typed.
  const task = loadTask(taskId)
  const handoff = readHandoff(task.metadata)
  if (handoff?.pending) {
    const context = buildHandoffContext(taskId, handoff)
    await s.session.send({ ...input, text: `${context}\n\nThe user's message:\n${input.text}` })
    const meta = JSON.parse(task.metadata ?? '{}')
    updateTaskMetadata(taskId, { ...meta, handoff: { ...handoff, pending: false } })
    return message
  }
  await s.session.send(input)
  return message
}

/**
 * Continues a task with another agent — e.g. when the current one ran out of
 * usage. The worktree, history and turns stay; the new agent starts a fresh
 * session and receives the story so far with the next message.
 */
export async function switchAgent(taskId: string, agentId: string): Promise<unknown> {
  const task = loadTask(taskId)
  if (task.process_type === agentId) return getTaskById(taskId)
  const live_ = live.get(taskId)
  if (live_?.status.inTurn) throw new Error('Stop the current turn before switching agents')
  const from = getAgent(task.process_type)
  const to = getAgent(agentId)
  if (to.id !== agentId || !isAgentAvailable(agentId)) throw new Error(`${to.label} is not installed`)

  await disposeSession(taskId)
  usageByTask.delete(taskId)
  peeked.delete(taskId)

  const meta = task.metadata ? JSON.parse(task.metadata) : {}
  const previous = readHandoff(task.metadata)
  const handoff: HandoffInfo = {
    from: from.id,
    // Switching twice before sending anything still hands over from the agent that did the work.
    fromLabel: previous?.pending ? previous.fromLabel : from.label,
    to: to.id,
    toLabel: to.label,
    at: Math.floor(Date.now() / 1000),
    pending: true
  }
  switchTaskAgent(taskId, agentId, { ...meta, handoff })
  const message = insertMessage({
    id: randomUUID(),
    task_id: taskId,
    role: 'system',
    kind: 'handoff',
    content: JSON.stringify({ from: from.id, fromLabel: from.label, to: to.id, toLabel: to.label })
  })
  if (message) emitToRenderer(taskId, { event: { type: 'raw', payload: { handoff: true } }, message })
  insertTaskEvent({
    id: randomUUID(),
    task_id: taskId,
    type: 'system',
    content: `Continued with ${to.label} (was ${from.label})`
  })
  return getTaskById(taskId)
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

function storedPlan(task: TaskRow): PlanItem[] {
  try {
    return task.plan_json ? (JSON.parse(task.plan_json) as PlanItem[]) : []
  } catch {
    return []
  }
}

/** State the renderer cannot rebuild from messages: streaming text and the plan. */
export interface LiveState {
  active: boolean
  inTurn: boolean
  streaming: Record<string, string>
  plan: PlanItem[]
  commands: SlashCommandInfo[]
  usage: SessionUsage | null
}

export function getLiveState(taskId: string): LiveState {
  const s = live.get(taskId)
  const usage = usageByTask.get(taskId) ?? null
  if (s) return { active: true, inTurn: s.status.inTurn, streaming: Object.fromEntries(s.streaming), plan: s.plan, commands: s.commands, usage }
  const task = getTaskById(taskId) as TaskRow | null
  return {
    active: false,
    inTurn: false,
    streaming: {},
    plan: task ? storedPlan(task) : [],
    commands: task ? agentCommands(task.process_type) : [],
    usage
  }
}

const peeked = new Map<string, Promise<void>>()

/**
 * Fills commands and context for a chat that has no live session (just
 * imported, or after a restart) by asking the agent without running a turn.
 * Once per task per app run.
 */
export function peekTask(taskId: string): Promise<LiveState> {
  if (live.has(taskId)) return Promise.resolve(getLiveState(taskId))
  let pending = peeked.get(taskId)
  if (!pending) {
    pending = (async () => {
      const task = loadTask(taskId)
      const peek = getAgent(task.process_type).chat?.peek
      if (peek) {
        try {
          const r = await peek({
            cwd: task.worktree_path || task.project_path,
            resumeSessionId: task.agent_session_id ?? undefined,
            model: task.model ?? undefined
          })
          if (r.commands?.length) rememberCommands(task.process_type, r.commands)
          if (r.usage && !usageByTask.has(taskId)) usageByTask.set(taskId, r.usage)
        } catch (err) {
          console.warn('[relay] could not read session details:', err)
        }
      }
    })()
    peeked.set(taskId, pending)
  }
  return pending.then(() => getLiveState(taskId))
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
