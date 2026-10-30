import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { AgentEvent, AgentSession, BackgroundTask, PlanItem, QuestionAnswers, SessionSettings, SessionUsage, SlashCommandInfo, TurnEndReason, UserInput } from '../agents/adapter'
import { getAgent, isAgentAvailable } from '../agents'
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
  getMessage,
  getMessageByToolCall,
  failRunningTools,
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
import { getSetting } from '../settings'
import { blockedResetAt } from './limit-reset'
import { cancelResume, initAutoResume, scheduleResume } from './auto-resume'
import { recordLimits } from './account-limits'
import { changedBetween, pathsTouchedBy, scanTree, type TreeState } from '../pipeline/tree'

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
  background: BackgroundTask[]
  /** Last reply text, for the "finished" notification. */
  lastText: string
  /** Set when the current turn ran into a usage limit; the value is when it resets, if known. */
  limitHit?: { resetsAt?: number }
  /** Texts the agent wrote in the current turn, for whoever waits on it. */
  turnTexts: string[]
  /** Last error the agent reported in the current turn. */
  turnError?: string
  /** For a pipeline's turn outside git: the tree before it, to tell what changed. */
  turnTree?: TreeState
  /** Files the agent's own tool calls say it edited this turn. */
  turnTouched: Set<string>
  /** The session's running cost after its last turn — a turn's own cost is the difference. */
  costTotal?: number
  /** Waiting for the current turn to end (pipeline steps). */
  turnWaiters: ((result: TurnResult) => void)[]
  unsubscribe: () => void
}

/** How a turn ended, for a pipeline step that ran it. */
export interface TurnResult {
  reason: TurnEndReason
  /** What the agent wrote, message by message. */
  texts: string[]
  changedFiles: string[]
  error?: string
  /** What the turn cost, when the agent reports it. */
  costUsd?: number
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

/** Tasks a pipeline run is working on: between its turns they are not done. */
const pipelineBusy = new Set<string>()

/** The status the task list shows: a finished turn of a running pipeline is not the end. */
function shownStatus(taskId: string, status: TaskStatus): TaskStatus {
  return pipelineBusy.has(taskId) && status === 'completed' ? 'running' : status
}

function setStatus(s: LiveSession, next: StatusState): void {
  const prev = shownStatus(s.taskId, s.status.status)
  s.status = next
  const shown = shownStatus(s.taskId, next.status)
  if (prev === shown) return
  updateTaskStatus(s.taskId, shown, { runtime_seconds: getTurnsRuntimeSeconds(s.taskId) })
  send('task:status', { taskId: s.taskId, status: shown })
  setAttentionCount([...live.values()].filter((x) => x.status.status === 'waiting').length)
}

/** Marks the task as worked on by a pipeline; when it ends, `final` is the task's status. */
export function setPipelineBusy(taskId: string, busy: boolean, final?: TaskStatus): void {
  if (busy) pipelineBusy.add(taskId)
  else pipelineBusy.delete(taskId)
  const s = live.get(taskId)
  const current = s?.status.status
  const status: TaskStatus = busy ? (current === 'waiting' ? 'waiting' : 'running') : (final ?? current ?? 'completed')
  if (s && !busy && final) s.status = { ...s.status, status: final }
  updateTaskStatus(taskId, status)
  send('task:status', { taskId, status })
  if (!busy && (final === 'completed' || final === 'failed')) {
    const task = getTaskById(taskId) as TaskRow | null
    if (task) notifyTask(taskId, `${task.title} ${final === 'failed' ? 'failed' : 'finished'}`, `Pipeline ${final === 'failed' ? 'failed' : 'done'}`)
  }
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
    sessionSettings: readMeta(task.metadata).sessionSettings as SessionSettings | undefined,
    getSetting
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
    background: [],
    turnTexts: [],
    turnTouched: new Set(),
    turnWaiters: [],
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
      if (e.progress) content.progress = { ...content.progress, ...e.progress }
      return updateMessage(row.id, { content: JSON.stringify(content), ...(e.running ? { tool_status: 'running' } : {}) })
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
        content: JSON.stringify({ title: e.title, detail: e.detail, options: e.options, questions: e.questions })
      })

    case 'permission.resolved': {
      if (!e.answers) return updateMessage(e.requestId, { tool_status: e.optionId })
      // Keep what was answered next to the questions, for the transcript
      const row = getMessage(e.requestId)
      const content = row?.content ? { ...(JSON.parse(row.content) as Record<string, unknown>), answers: e.answers } : undefined
      return updateMessage(e.requestId, { tool_status: e.optionId, content: content ? JSON.stringify(content) : undefined })
    }

    case 'error':
      return insertMessage({ id: randomUUID(), task_id: taskId, turn_id: turnId, role: 'system', kind: 'error', content: e.message })

    default:
      return undefined
  }
}

function handleEvent(s: LiveSession, e: AgentEvent): void {
  const { taskId } = s
  for (const p of pathsTouchedBy(e, s.cwd)) s.turnTouched.add(p)

  switch (e.type) {
    case 'session.started':
      updateTaskAgentSessionId(taskId, e.sessionId)
      if (e.mode) updateTaskChatSettings(taskId, { mode: e.mode })
      break

    case 'turn.started': {
      s.turnId = e.turnId
      s.turnTexts = []
      s.turnError = undefined
      s.turnTouched = new Set()
      const before = snapshotWorkingTree(s.cwd, taskId, `${e.turnId}-before`) ?? undefined
      // Without git a pipeline still needs to know what the turn changed
      s.turnTree = !before && pipelineBusy.has(taskId) ? scanTree(s.cwd) : undefined
      insertTurn({ id: e.turnId, task_id: taskId, commit_before: before })
      break
    }

    case 'message.delta':
      s.streaming.set(e.messageId, (s.streaming.get(e.messageId) ?? '') + e.text)
      break

    case 'message.completed':
      s.streaming.delete(e.messageId)
      if (e.text.trim()) {
        s.lastText = e.text
        s.turnTexts.push(e.text)
      }
      break

    case 'error':
      s.turnError = e.message
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
      // Plan limits belong to the account, not the task: keep them for Settings
      if (e.usage.limits?.length) recordLimits(loadTask(taskId).process_type, e.usage.limits)
      break
    }

    case 'permission.requested':
      notifyTask(
        taskId,
        `${loadTask(taskId).title} ${e.questions ? 'has a question' : 'needs approval'}`,
        e.questions ? e.questions[0].question : e.title
      )
      break

    case 'plan.updated':
      s.plan = e.items
      updateTaskPlan(taskId, e.items)
      break

    case 'background.updated':
      s.background = e.tasks
      break

    case 'limit.reached':
      s.limitHit = { resetsAt: e.resetsAt }
      break

    case 'turn.completed': {
      // A refused turn continues by itself once the limit resets. Agents that do not
      // say so explicitly still report the used-up limit.
      const resetsAt =
        s.limitHit?.resetsAt ?? (e.reason === 'error' ? blockedResetAt(usageByTask.get(taskId)?.limits) : undefined)
      s.limitHit = undefined
      if (resetsAt && e.reason !== 'interrupted') scheduleResume(taskId, resetsAt)
      finishTurn(s, e)
      break
    }

    case 'session.exited':
      resolveTurn(s, { reason: 'error', texts: s.turnTexts, changedFiles: [], error: s.turnError ?? 'The agent exited' })
      setStatus(s, reduceStatus(s.status, e))
      failRunningTools(taskId)
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
  // Agents report a running total; this turn's cost is what it added
  const total = e.usage?.costUsd
  const turnCost = total === undefined ? undefined : s.costTotal !== undefined && total >= s.costTotal ? total - s.costTotal : total
  if (total !== undefined) s.costTotal = total
  if (s.turnWaiters.length) {
    const scanned = s.turnTree ? changedBetween(s.cwd, s.turnTree, scanTree(s.cwd)) : []
    const files = [...new Set([...changed.map((f) => f.path), ...scanned, ...s.turnTouched])].sort()
    resolveTurn(s, { reason: e.reason, texts: s.turnTexts, changedFiles: files, error: s.turnError, costUsd: turnCost })
  }
  s.turnTree = undefined
  // With subagents still working the turn only handed off; their own report finishes the task.
  // A pipeline's turns are steps of it: the run says when it is done.
  if (e.reason !== 'interrupted' && !(e.reason !== 'error' && s.status.agents > 0) && !pipelineBusy.has(taskId)) {
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
}

function resolveTurn(s: LiveSession, result: TurnResult): void {
  const waiters = s.turnWaiters
  s.turnWaiters = []
  for (const w of waiters) w(result)
}

// --- Public API (used by IPC handlers) --------------------------------------

/**
 * Writes the task's recap on request: the previous recap plus whatever was said
 * since. Runs a headless agent call, so it is never triggered automatically.
 */
export async function recapTask(taskId: string): Promise<void> {
  const task = loadTask(taskId)
  const rows = getTaskSummaries(taskId)
  const last = rows.length ? rows[rows.length - 1] : null
  const existing = last ? (JSON.parse(last.summary_json) as { text?: string }) : null
  // Recaps are stamped in seconds, messages in milliseconds.
  const since = last && existing?.text ? last.created_at * 1000 : 0
  const newMessages = getMessages(taskId, { limit: 2000 }).filter((m) => m.created_at >= since)
  if (since && !newMessages.some((m) => m.kind === 'text' && m.content)) return

  const userPrompts = newMessages
    .filter((m) => m.role === 'user' && m.kind === 'text' && m.content)
    .slice(-5)
    .map((m) => m.content as string)
  const transcript = newMessages
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
}

export async function sendMessage(taskId: string, input: UserInput): Promise<MessageRow | undefined> {
  // A message from the user (or the auto-continue itself) replaces a pending continuation
  cancelResume(taskId)
  const s = await ensureSession(taskId)
  const message = recordUserMessage(taskId, input)
  await deliver(s, input)
  return message
}

/** Puts what the user typed into the chat, without sending it to the agent yet. */
export function recordUserMessage(taskId: string, input: UserInput, kind: 'text' | 'pipeline_prompt' = 'text'): MessageRow | undefined {
  const attachments = (input.images ?? []).map((img) => saveAttachment(taskId, img))
  const message = insertMessage({
    id: randomUUID(),
    task_id: taskId,
    turn_id: live.get(taskId)?.turnId ?? null,
    role: 'user',
    kind,
    content: input.text,
    attachments
  })
  if (message) emitToRenderer(taskId, { event: { type: 'raw', payload: { userMessage: true } }, message })
  return message
}

async function deliver(s: LiveSession, input: UserInput): Promise<void> {
  // First message to an agent that took the task over: it gets the story so far
  // in front of it. The chat shows only what the user typed.
  const task = loadTask(s.taskId)
  const handoff = readHandoff(task.metadata)
  if (handoff?.pending) {
    const context = buildHandoffContext(s.taskId, handoff)
    await s.session.send({ ...input, text: `${context}\n\nThe user's message:\n${input.text}` })
    const meta = JSON.parse(task.metadata ?? '{}')
    updateTaskMetadata(s.taskId, { ...meta, handoff: { ...handoff, pending: false } })
    return
  }
  await s.session.send(input)
}

/**
 * Runs one turn in the task's session for a pipeline step and waits for it to
 * end. A turn already going is waited out first. With `show`, the prompt
 * appears in the chat as sent by the pipeline. Aborting interrupts the turn.
 */
export async function runTurn(
  taskId: string,
  input: UserInput,
  opts: { show?: boolean; signal?: AbortSignal } = {}
): Promise<TurnResult> {
  const interrupted: TurnResult = { reason: 'interrupted', texts: [], changedFiles: [] }
  let s = await ensureSession(taskId)
  while (s.status.inTurn) {
    await new Promise<TurnResult>((resolve) => s.turnWaiters.push(resolve))
    if (opts.signal?.aborted) return interrupted
    s = await ensureSession(taskId)
  }
  if (opts.signal?.aborted) return interrupted
  cancelResume(taskId)
  if (opts.show) recordUserMessage(taskId, input, 'pipeline_prompt')
  const done = new Promise<TurnResult>((resolve) => {
    s.turnWaiters.push(resolve)
    opts.signal?.addEventListener(
      'abort',
      () => {
        void s.session.interrupt().catch(() => {})
        resolve(interrupted)
      },
      { once: true }
    )
  })
  await deliver(s, input)
  return done
}

/** Permission prompts of a pipeline step's own session, answered from the task's chat. */
const sidePermissions = new Map<string, AgentSession>()

/** Shows a permission prompt (or its answer) from a session that is not the task's own. */
export function showSidePermission(
  taskId: string,
  session: AgentSession,
  e: Extract<AgentEvent, { type: 'permission.requested' | 'permission.resolved' }>
): void {
  if (e.type === 'permission.requested') {
    sidePermissions.set(e.requestId, session)
    notifyTask(taskId, `${loadTask(taskId).title} needs approval`, e.title)
  } else {
    sidePermissions.delete(e.requestId)
  }
  const message = persistEvent(taskId, live.get(taskId)?.turnId ?? null, e)
  emitToRenderer(taskId, { event: e, message })
}

/** Prompts of a side session that ended: nobody can answer them anymore. */
export function expireSidePermissions(taskId: string, session: AgentSession): void {
  for (const [requestId, owner] of sidePermissions) {
    if (owner !== session) continue
    sidePermissions.delete(requestId)
    const message = updateMessage(requestId, { tool_status: 'expired' })
    if (message) emitToRenderer(taskId, { event: { type: 'raw', payload: { expired: requestId } }, message })
  }
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
  // The new agent takes over; the old one's limit no longer matters
  cancelResume(taskId)
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

export function respondPermission(taskId: string, requestId: string, optionId: string, answers?: QuestionAnswers): void {
  const side = sidePermissions.get(requestId)
  if (side) return side.respondPermission(requestId, optionId, answers)
  live.get(taskId)?.session.respondPermission(requestId, optionId, answers)
}

function readMeta(metadata: string | null | undefined): Record<string, unknown> {
  try {
    return metadata ? (JSON.parse(metadata) as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Changes one of the task's session settings (the chat's /config); null returns it
 * to the agent's own configuration. Kept with the task and applied to a live session.
 */
export async function setSessionSetting(taskId: string, key: string, value: string | boolean | null): Promise<void> {
  const meta = readMeta(loadTask(taskId).metadata)
  const settings = { ...((meta.sessionSettings as SessionSettings | undefined) ?? {}) }
  if (value === null) delete settings[key]
  else settings[key] = value
  meta.sessionSettings = settings
  updateTaskMetadata(taskId, meta)
  send('task:metadata', { taskId, metadata: JSON.stringify(meta) })
  await live.get(taskId)?.session.applySessionSettings?.({ [key]: value })
}

/** Choices for the task's select settings that only a running session knows. */
export async function sessionSettingOptions(taskId: string): Promise<Record<string, { id: string; label: string }[]>> {
  return (await live.get(taskId)?.session.sessionSettingOptions?.().catch(() => ({}))) ?? {}
}

export async function moveToBackground(taskId: string, toolCallId: string): Promise<boolean> {
  return (await live.get(taskId)?.session.moveToBackground?.(toolCallId)) ?? false
}

export async function stopBackgroundTask(taskId: string, backgroundId: string): Promise<void> {
  await live.get(taskId)?.session.stopBackgroundTask?.(backgroundId)
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
  background: BackgroundTask[]
}

export function getLiveState(taskId: string): LiveState {
  const s = live.get(taskId)
  const usage = usageByTask.get(taskId) ?? null
  if (s) {
    return {
      active: true,
      inTurn: s.status.inTurn,
      streaming: Object.fromEntries(s.streaming),
      plan: s.plan,
      commands: s.commands,
      usage,
      background: s.background
    }
  }
  const task = getTaskById(taskId) as TaskRow | null
  return {
    active: false,
    inTurn: false,
    streaming: {},
    plan: task ? storedPlan(task) : [],
    commands: task ? agentCommands(task.process_type) : [],
    usage,
    // Background work ends with the agent's process
    background: []
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

/** Starts continuing tasks after their usage limit resets; call once the database is up. */
export function startAutoResume(): void {
  initAutoResume(async (taskId, text) => {
    if (!getTaskById(taskId) || live.get(taskId)?.status.inTurn) return
    insertTaskEvent({ id: randomUUID(), task_id: taskId, type: 'system', content: 'Usage limit reset — continued automatically' })
    await sendMessage(taskId, { text })
  })
}

export async function disposeSession(taskId: string): Promise<void> {
  const s = live.get(taskId)
  if (!s) return
  live.delete(taskId)
  s.unsubscribe()
  await s.session.dispose()
}

/**
 * Restarts the agent's idle sessions after a sign-in, so they pick up the new
 * credentials; each resumes its conversation with the next message.
 */
export async function restartIdleSessions(agentId: string): Promise<void> {
  const idle = [...live.values()].filter(
    (s) => !s.status.inTurn && s.status.agents === 0 && (getTaskById(s.taskId) as TaskRow | null)?.process_type === agentId
  )
  await Promise.all(idle.map((s) => disposeSession(s.taskId)))
}

export async function disposeAllSessions(): Promise<void> {
  await Promise.all([...live.keys()].map(disposeSession))
}
