import { BrowserWindow } from 'electron'
import { insertTerminalLog, updateTaskStatus, getTaskById, appendTaskSummary, getTaskSummaries, getTaskEvents, getTerminalLogs } from '../db'
import { generateSessionSummary } from '../summary/generator'
import { getAgent, sanitizeArgForShell, type AgentDefinition } from '../agents'

// Lazy-load node-pty so a missing native binding doesn't crash the whole app
let pty: typeof import('node-pty') | null = null
try {
  pty = require('node-pty')
} catch {
  console.warn('[relay] node-pty not available — PTY sessions disabled')
}

interface PtySession {
  id: string
  taskId: string
  process: pty.IPty
  cols: number
  rows: number
}

const sessions = new Map<string, PtySession>()
// Sessions killed intentionally (Stop button / app quit)
const killedSessions = new Set<string>()
// Per-session polling intervals watching for agent completion
const completionWatchers = new Map<string, ReturnType<typeof setInterval>>()

// --- Inactivity-based status management ---
const inactivityTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Track last emitted status to avoid redundant updates
const sessionStatuses = new Map<string, string>()
// Tasks locked in completed state — won't revert to running until user sends a new prompt
const lockedStatuses = new Set<string>()

const INACTIVITY_MS = 15_000
// Strips standard CSI sequences (including private ?/!/< prefixes), OSC, DCS, SOS/PM/APC, character-set designators, and bare Fe sequences
const ANSI_RE = /\x1b(?:\[[0-9;?!<>]*[a-zA-Z@]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[()][0-9A-Za-z]|[=>NOMc])/g

function emitStatusChange(taskId: string, status: 'running' | 'completed'): void {
  const prev = sessionStatuses.get(taskId)
  if (prev === status) return
  sessionStatuses.set(taskId, status)
  if (status === 'completed') {
    lockedStatuses.add(taskId)
  }
  updateTaskStatus(taskId, status)
  BrowserWindow.getAllWindows()[0]?.webContents.send(`pty:status:${taskId}`, status)
}

function scheduleInactivityCheck(taskId: string): void {
  const existing = inactivityTimers.get(taskId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(async () => {
    inactivityTimers.delete(taskId)
    if (!sessions.has(`pty-${taskId}`)) return

    const newStatus = 'completed' as const
    emitStatusChange(taskId, newStatus)

    // Generate or incrementally update the single task summary
    try {
      const task = getTaskById(taskId) as {
        project_path: string
        worktree_path?: string
        metadata?: string
        process_type: string
      } | null
      if (!task) return

      const meta = task.metadata ? JSON.parse(task.metadata) : {}

      // Load existing summary (if any) to determine incremental vs. fresh generation
      const summaryRows = getTaskSummaries(taskId)
      const existingSummary: { text?: string; lastLogId?: number; timestamp?: string } | null =
        summaryRows.length > 0
          ? (() => { try { return JSON.parse(summaryRows[summaryRows.length - 1].summary_json) } catch { return null } })()
          : null

      // All terminal logs — used for maxLogId tracking and new-output extraction
      const allLogs = getTerminalLogs(taskId) as Array<{ id: number; data: string }>
      const lastLogId = (existingSummary?.lastLogId as number | undefined) ?? 0

      // Only use logs produced since the previous summary was generated
      const newLogs = lastLogId > 0 ? allLogs.filter((l) => l.id > lastLogId) : allLogs
      const agentOutput = newLogs
        .map((l) => l.data)
        .join('')
        .replace(ANSI_RE, '')
        .replace(/\r/g, '')

      // Collect only new user prompts (since the last summary timestamp)
      const events = getTaskEvents(taskId) as Array<{ type: string; content: string; timestamp: number }>
      let userPrompts: string[]
      if (existingSummary?.timestamp) {
        const lastTs = Math.floor(new Date(existingSummary.timestamp).getTime() / 1000)
        userPrompts = events
          .filter((e) => e.type === 'user_prompt' && e.content && (e.timestamp ?? 0) > lastTs)
          .map((e) => e.content)
      } else {
        userPrompts = events
          .filter((e) => e.type === 'user_prompt' && e.content)
          .map((e) => e.content)
      }

      // Record max log ID so the next incremental update only processes new output
      const maxLogId = allLogs.length > 0 ? Math.max(...allLogs.map((l) => l.id)) : 0

      // Use the task's worktree for git context if available; fall back to project root
      const summaryCwd = task.worktree_path || task.project_path

      const summary = await generateSessionSummary({
        taskId,
        agentId: task.process_type,
        userPrompts,
        cwd: summaryCwd,
        startCommit: meta.startCommit,
        status: newStatus,
        agentOutput,
        existingSummaryText: existingSummary?.text,
        lastLogId: maxLogId
      })

      const json = JSON.stringify(summary)
      appendTaskSummary(taskId, json)
      BrowserWindow.getAllWindows()[0]?.webContents.send(`pty:summary:${taskId}`, JSON.stringify([summary]))
    } catch (err) {
      console.warn('[relay] Failed to generate session summary:', err)
    }
  }, INACTIVITY_MS)
  inactivityTimers.set(taskId, timer)
}

function clearInactivityTracking(taskId: string): void {
  const t = inactivityTimers.get(taskId)
  if (t) { clearTimeout(t); inactivityTimers.delete(taskId) }
  sessionStatuses.delete(taskId)
  lockedStatuses.delete(taskId)
}

/** Unlock status lock for a task so the next terminal output can set it back to running.
 *  Call this when the user sends a new prompt to an already-completed/waiting task. */
export function unlockTaskStatus(taskId: string): void {
  lockedStatuses.delete(taskId)
}

/** Pre-populate lockedStatuses from persisted DB state so completed/waiting tasks
 *  stay locked after an app restart, even if a PTY session is somehow created for them. */
export function initLockedStatuses(taskIds: string[]): void {
  for (const id of taskIds) lockedStatuses.add(id)
}

/** Write a potentially large string to PTY in chunks to avoid ConPTY/node-pty buffer limits (~4 KB on Windows) */
function writeLarge(proc: pty.IPty, text: string, chunkSize = 2048, delayMs = 10, onDone?: () => void): void {
  let offset = 0
  const writeNext = () => {
    if (offset >= text.length) {
      onDone?.()
      return
    }
    proc.write(text.slice(offset, offset + chunkSize))
    offset += chunkSize
    if (offset < text.length) {
      setTimeout(writeNext, delayMs)
    } else {
      onDone?.()
    }
  }
  writeNext()
}

export interface CreatePtySessionOptions {
  taskId: string
  /** Agent id (`tasks.process_type`) — decides status tracking and prompt handling. */
  agentId: string
  /** Executable + args produced by `resolveLaunch`. */
  command: { cmd: string; args: string[] }
  cwd: string
  /** Prompt to type into the agent's TUI once it is ready (input-delivery agents). */
  typedPrompt?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export function createPtySession(opts: CreatePtySessionOptions): string {
  const {
    taskId,
    agentId,
    command,
    cwd,
    typedPrompt,
    env,
    cols = 80,
    rows = 24
  } = opts

  const agent: AgentDefinition = getAgent(agentId)
  const sessionId = `pty-${taskId}`
  if (!pty) {
    console.warn('[relay] PTY session skipped — node-pty not available')
    return sessionId
  }

  const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash'
  const resolvedEnv = {
    ...process.env,
    ...(env ?? {}),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor'
  } as Record<string, string>

  // A tracked agent gets status detection and summaries; a plain shell session
  // (or a command that *is* the shell) is left alone.
  const isAgent = agent.tracked && command.cmd !== shell

  // Always spawn an interactive shell — the agent command is written to it below.
  // This avoids ConPTY child-process handle-inheritance issues on Windows where
  // spawning an agent directly (cmd.exe /c) would keep the PTY alive after the
  // agent exits if it has lingering grandchildren.
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || process.env.HOME || '/',
    env: resolvedEnv
  })

  sessions.set(sessionId, { id: sessionId, taskId, process: ptyProcess, cols, rows })

  // Shared flag: set to true the moment cmd.exe produces its first output.
  // Used by the agent command scheduler below to know the shell is ready.
  let shellStarted = false

  ptyProcess.onData((data) => {
    shellStarted = true
    try {
      insertTerminalLog(taskId, data)
    } catch {
      // Task may have been deleted while PTY still had buffered data
    }
    BrowserWindow.getAllWindows()[0]?.webContents.send(`pty:data:${taskId}`, data)

    // Inactivity-based status tracking (only for agent sessions)
    if (isAgent) {
      // Skip status/timer updates while status is locked (completed) —
      // status will unlock only when the user sends a new prompt
      if (!lockedStatuses.has(taskId)) {
        emitStatusChange(taskId, 'running')
        scheduleInactivityCheck(taskId)
      }
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    sessions.delete(sessionId)
    const watcher = completionWatchers.get(taskId)
    if (watcher) { clearInterval(watcher); completionWatchers.delete(taskId) }
    clearInactivityTracking(taskId)

    if (killedSessions.has(sessionId)) {
      killedSessions.delete(sessionId)
      return
    }
    // Only update status if the task isn't already in a terminal state
    // (e.g. agent completion was already detected via signal file)
    const current = getTaskById(taskId) as { status: string } | null
    const alreadyDone = current?.status === 'completed' || current?.status === 'failed' || current?.status === 'paused'
    if (!alreadyDone) {
      const status = exitCode === 0 ? 'completed' : 'failed'
      updateTaskStatus(taskId, status)
    }
    BrowserWindow.getAllWindows()[0]?.webContents.send(`pty:exit:${taskId}`, exitCode)
  })

  if (isAgent) {
    // Quote args that contain spaces so prompts passed on the command line aren't truncated
    const quoteArg = (raw: string): string => {
      const a = sanitizeArgForShell(raw)
      if (!/\s|"|'/.test(a)) return a
      return process.platform === 'win32'
        ? `"${a.replace(/"/g, '""')}"` // cmd.exe: double inner quotes
        : `'${a.replace(/'/g, "'\\''")}'` // bash: single-quote with escaping
    }
    const agentCmd = command.args.length
      ? `${command.cmd} ${command.args.map(quoteArg).join(' ')}`
      : command.cmd

    // Wait for the shell to produce its first output (proof it's alive), then
    // write the agent command 100 ms later.  Polling via the shared shellStarted
    // flag avoids adding a second onData listener (which can disrupt the first one
    // on some node-pty builds).  Hard fallback at 4 s covers cold-start delays.
    let commandWritten = false
    const writeAgent = () => {
      if (commandWritten || !sessions.has(sessionId)) return
      commandWritten = true

      ptyProcess.write(`${agentCmd}\r`)

      if (typedPrompt) {
        // Two-signal approach to reliably deliver the initial prompt to an
        // agent whose TUI expects it as keyboard input:
        //
        // Signal A (fast path): the agent's own readiness marker
        //   (`agent.promptReadyPattern`, e.g. Claude Code's "> " / "❯ ") appears
        //   at the end of the ANSI-stripped output stream. Once detected, we
        //   wait an additional 300 ms of silence so the TUI finishes any
        //   residual rendering, then send.
        //
        // Signal B (fallback): if the agent declares no pattern, or its UI
        //   changed in a newer version, fire after 3 s of silence, but only
        //   after at least 2 s have elapsed since the command was written —
        //   this prevents sending during early banner bursts that have brief
        //   pauses.
        //
        // Hard fallback at 30 s covers extremely slow first-time startups.

        const readyPattern = agent.promptReadyPattern
        let promptSent = false
        let lastOutput = Date.now()
        const cmdWrittenAt = Date.now()

        // Accumulate ANSI-stripped output to detect the readiness marker
        let cleanBuf = ''
        let promptIndicatorAt = 0  // timestamp when the marker was first detected

        const outputWatcher = ptyProcess.onData((data) => {
          if (promptSent) return
          // Tracked for Signal B regardless of whether the agent declares a marker
          lastOutput = Date.now()
          if (!readyPattern) return

          // Strip ANSI and accumulate for readiness detection
          const clean = data.replace(ANSI_RE, '').replace(/\r/g, '')
          cleanBuf += clean
          if (cleanBuf.length > 6000) cleanBuf = cleanBuf.slice(-6000)

          // Require at least 100 chars so we don't fire on the shell prompt itself.
          if (!promptIndicatorAt && cleanBuf.length > 100 && readyPattern.test(cleanBuf)) {
            promptIndicatorAt = Date.now()
          }
        })

        const sendPrompt = () => {
          if (promptSent || !sessions.has(sessionId)) return
          promptSent = true
          clearInterval(checkInterval)
          outputWatcher.dispose()
          writeLarge(ptyProcess, typedPrompt, 64, 25, () => {
            if (sessions.has(sessionId)) ptyProcess.write('\r')
          })
        }

        const checkInterval = setInterval(() => {
          if (promptSent) { clearInterval(checkInterval); return }
          const now = Date.now()
          const silence = now - lastOutput
          const elapsed = now - cmdWrittenAt

          // Signal A: prompt indicator detected + 300 ms silence
          if (promptIndicatorAt && silence >= 300) {
            sendPrompt()
            return
          }

          // Signal B: 3 s silence AND at least 2 s since command was written
          if (silence >= 3000 && elapsed >= 2000) {
            sendPrompt()
          }
        }, 100)

        // Hard fallback: send after 30 s regardless (covers very slow first-time startups)
        setTimeout(sendPrompt, 30_000)
      }
    }

    // Poll every 50 ms until the shell produces output, then fire writeAgent
    // after a 100 ms settling pause.  Falls back after 4 s unconditionally.
    let elapsed = 0
    const pollInterval = setInterval(() => {
      elapsed += 50
      if (!shellStarted && elapsed < 4000) return
      clearInterval(pollInterval)
      if (shellStarted) {
        setTimeout(writeAgent, 100)
      } else {
        writeAgent() // 4 s fallback — write immediately
      }
    }, 50)
  }

  return sessionId
}

export function writeToPty(taskId: string, data: string): boolean {
  const sessionId = `pty-${taskId}`
  const session = sessions.get(sessionId)
  if (!session) return false
  session.process.write(data)
  return true
}

export function resizePty(taskId: string, cols: number, rows: number): void {
  const sessionId = `pty-${taskId}`
  const session = sessions.get(sessionId)
  if (session) {
    session.process.resize(cols, rows)
    session.cols = cols
    session.rows = rows
  }
}

export function killPtySession(taskId: string): void {
  const sessionId = `pty-${taskId}`
  const watcher = completionWatchers.get(taskId)
  if (watcher) { clearInterval(watcher); completionWatchers.delete(taskId) }
  clearInactivityTracking(taskId)
  const session = sessions.get(sessionId)
  if (session) {
    killedSessions.add(sessionId)
    session.process.kill()
    sessions.delete(sessionId)
  }
}

export function killAllSessions(): void {
  for (const interval of completionWatchers.values()) clearInterval(interval)
  completionWatchers.clear()

  // Tasks with a pending inactivity timer were idle (agent stopped outputting) but
  // the 15-second window hadn't elapsed yet. Mark them completed now so that after
  // an app restart they don't revert to 'paused' via resetRunningTasks().
  for (const taskId of inactivityTimers.keys()) {
    updateTaskStatus(taskId, 'completed')
  }
  for (const timer of inactivityTimers.values()) clearTimeout(timer)
  inactivityTimers.clear()

  // Do NOT clear lockedStatuses or sessionStatuses here.
  // Clearing lockedStatuses before killing processes causes a race: if the PTY
  // emits a final data chunk after kill() but before the process dies, onData fires
  // and emitStatusChange('running') overwrites the DB status back to 'running'.
  // On the next app start resetRunningTasks() would then flip it to 'paused'.
  for (const [sessionId, session] of sessions) {
    killedSessions.add(sessionId)
    session.process.kill()
  }
  sessions.clear()
}

export function getActiveSessions(): string[] {
  return Array.from(sessions.keys())
}
