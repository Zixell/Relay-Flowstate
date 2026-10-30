import { BrowserWindow, Notification } from 'electron'
import { randomUUID } from 'crypto'
import type { UserInput } from '../agents/adapter'
import { getAgent } from '../agents'
import { getTaskById, insertMessage, type MessageRow } from '../db'
import { commitStaged, getCurrentCommit, getWorkingDirStatus, stageFiles } from '../git'
import { diffSnapshotFiles, snapshotWorkingTree } from '../git/snapshots'
import { getSetting } from '../settings'
import { cancelResume } from '../session/auto-resume'
import {
  expireSidePermissions,
  recordUserMessage,
  runTurn,
  sendMessage,
  setPipelineBusy,
  showSidePermission,
  type ChatEventPayload
} from '../session/manager'
import { PipelineRun, type RunEvent } from './engine'
import { createRunner } from './runner'
import { pipelineForTask, recordRun } from './store'
import type { Pipeline, RunStatus, StepOutput } from './types'

interface TaskInfo {
  id: string
  title: string
  process_type: string
  project_path: string
  worktree_path?: string | null
}

interface ActiveRun {
  runId: string
  run: PipelineRun
  /** Messages the user sent during the run; each starts the next run. */
  queue: { input: UserInput; message?: MessageRow }[]
}

const active = new Map<string, ActiveRun>()

function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function chatEvent(taskId: string, message: MessageRow | undefined, payload: unknown): void {
  if (!message) return
  send(`chat:event:${taskId}`, { event: { type: 'raw', payload }, message } satisfies ChatEventPayload)
}

/**
 * A message from the user. With a pipeline for the task, the message starts a
 * run (or waits for the running one); without, it goes to the agent as before.
 */
export async function submitMessage(taskId: string, input: UserInput): Promise<MessageRow | undefined> {
  const running = active.get(taskId)
  if (running) {
    const message = recordUserMessage(taskId, input)
    running.queue.push({ input, message })
    return message
  }
  const pipeline = pipelineForTask(taskId)
  if (!pipeline) return sendMessage(taskId, input)
  cancelResume(taskId)
  const message = recordUserMessage(taskId, input)
  start(taskId, pipeline, input, message)
  return message
}

/** Stops the task's run; messages queued behind it are dropped from the queue (they stay in the chat). */
export function cancelRun(taskId: string): void {
  const running = active.get(taskId)
  if (!running) return
  running.queue = []
  running.run.cancel()
}

export function activeRunId(taskId: string): string | null {
  return active.get(taskId)?.runId ?? null
}

function start(taskId: string, pipeline: Pipeline, input: UserInput, message: MessageRow | undefined): void {
  const task = getTaskById(taskId) as TaskInfo | null
  if (!task) return
  const cwd = task.worktree_path || task.project_path
  const runId = randomUUID()

  let record: ((e: RunEvent) => void) | undefined
  let run: PipelineRun
  try {
    run = new PipelineRun(pipeline, {
      runId,
      input: input.text,
      runner: createRunner({
        agentId: task.process_type,
        cwd,
        images: input.images,
        runTurn: (turnInput, opts) => runTurn(taskId, turnInput, opts),
        openSession: (agentId) => {
          const agent = getAgent(agentId)
          if (!agent.chat) throw new Error(`${agent.label} does not support chat mode`)
          return agent.chat.createSession({ taskId, cwd, getSetting })
        },
        onSideEvent: (session, e) => {
          if (e.type === 'permission.requested' || e.type === 'permission.resolved') showSidePermission(taskId, session, e)
        },
        onSideClosed: (session) => expireSidePermissions(taskId, session),
        snapshot: (label) => snapshotWorkingTree(cwd, taskId, label),
        changedFiles: (from, to) => diffSnapshotFiles(cwd, from, to).map((f) => f.path),
        commit: (msg) => commitAll(cwd, msg),
        notify: (msg) => {
          if (Notification.isSupported()) new Notification({ title: task.title, body: msg }).show()
        }
      }),
      onEvent: (e) => {
        record?.(e)
        send(`pipeline:event:${taskId}`, e)
      }
    })
  } catch (err) {
    // A stored pipeline is valid when saved; one that is not anymore must not swallow the message
    const error = insertMessage({
      id: randomUUID(),
      task_id: taskId,
      role: 'system',
      kind: 'error',
      content: `Pipeline "${pipeline.name}" was skipped: ${err instanceof Error ? err.message : String(err)}`
    })
    chatEvent(taskId, error, { pipelineError: true })
    void sendMessage(taskId, input).catch((e) => console.error('[relay] send failed:', e))
    return
  }

  record = recordRun({ id: runId, taskId, pipeline, messageId: message?.id ?? null, input: input.text })
  const entry: ActiveRun = { runId, run, queue: [] }
  active.set(taskId, entry)
  const card = insertMessage({
    id: randomUUID(),
    task_id: taskId,
    role: 'system',
    kind: 'pipeline',
    content: JSON.stringify({ runId, name: pipeline.name })
  })
  chatEvent(taskId, card, { pipelineRun: runId })
  setPipelineBusy(taskId, true)

  void run.start().then((result) => {
    active.delete(taskId)
    setPipelineBusy(taskId, false, taskStatusAfter(result.status))
    const next = entry.queue.shift()
    if (!next) return
    // The rest of the queue waits behind the next run
    const pipelineNow = pipelineForTask(taskId)
    if (pipelineNow) {
      start(taskId, pipelineNow, next.input, next.message)
      const after = active.get(taskId)
      if (after) after.queue.push(...entry.queue)
    } else {
      void sendMessage(taskId, next.input).catch((e) => console.error('[relay] send failed:', e))
    }
  })
}

function taskStatusAfter(status: RunStatus): 'completed' | 'failed' | 'paused' {
  return status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'paused'
}

function commitAll(cwd: string, message: string): StepOutput {
  const status = getWorkingDirStatus(cwd)
  if (!status.isGitRepo) return { status: 'error', output: '', error: 'Not a git repository' }
  if (!status.files.length) return { status: 'ok', output: 'Nothing to commit' }
  const staged = stageFiles(cwd, ['.'])
  if (!staged.success) return { status: 'error', output: staged.stderr, error: 'Could not stage the changes' }
  const committed = commitStaged(cwd, message)
  if (!committed.success) return { status: 'error', output: committed.stderr, error: 'Commit failed' }
  return { status: 'ok', output: `Committed ${getCurrentCommit(cwd).slice(0, 8)}: ${message}`, changedFiles: status.files.map((f) => f.path) }
}
