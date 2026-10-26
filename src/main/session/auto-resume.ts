import { BrowserWindow, powerMonitor } from 'electron'
import { getAllTasks, getTaskById, updateTaskMetadata } from '../db'
import { getSetting } from '../settings'

/**
 * Tasks that stopped on a usage limit continue on their own once it resets.
 *
 * One timer serves the whole app, set for the earliest due task, so idle chats
 * cost nothing however many there are. The due time lives in the task's
 * metadata (`resumeAt`) and survives a restart; overdue tasks continue shortly
 * after launch.
 */

/** App setting; anything but 'false' means on. */
export const AUTO_CONTINUE = 'RELAY_AUTO_CONTINUE'

const RESUME_TEXT = 'Continue where you left off.'
/** Limits reset on the dot; give the provider a moment before trying again. */
const MARGIN_MS = 60_000
/** Spacing between continued tasks, so they do not all start an agent at once. */
const GAP_MS = 5_000
/** Overdue tasks wait this long after launch, for the window to come up. */
const STARTUP_DELAY_MS = 10_000
/** setTimeout cannot wait longer than this. */
const MAX_DELAY_MS = 2 ** 31 - 1

const due = new Map<string, number>()
let timer: ReturnType<typeof setTimeout> | null = null
let firing = false
let resume: (taskId: string, text: string) => Promise<void> = async () => {}

export const autoContinueEnabled = (): boolean => getSetting(AUTO_CONTINUE) !== 'false'

function readMeta(taskId: string): Record<string, unknown> | null {
  const task = getTaskById(taskId) as { metadata: string | null } | null
  if (!task) return null
  try {
    return task.metadata ? JSON.parse(task.metadata) : {}
  } catch {
    return {}
  }
}

/** Stores resumeAt (or drops it) and tells the renderer. */
function persist(taskId: string, at: number | undefined): void {
  const meta = readMeta(taskId)
  if (!meta) return
  if (at === undefined) delete meta.resumeAt
  else meta.resumeAt = at
  updateTaskMetadata(taskId, meta)
  const metadata = JSON.stringify(meta)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('task:metadata', { taskId, metadata })
}

function arm(minDelay = 0): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!due.size || firing) return
  const next = Math.min(...due.values())
  timer = setTimeout(() => void fire(), Math.min(Math.max(next - Date.now(), minDelay), MAX_DELAY_MS))
}

async function fire(): Promise<void> {
  timer = null
  firing = true
  try {
    const now = Date.now()
    const ready = [...due].filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1])
    for (const [i, [taskId]] of ready.entries()) {
      cancelResume(taskId)
      if (!autoContinueEnabled()) continue
      if (i > 0) await new Promise((r) => setTimeout(r, GAP_MS))
      await resume(taskId, RESUME_TEXT).catch((err) => console.warn('[relay] auto-continue failed:', err))
    }
  } finally {
    firing = false
    arm()
  }
}

/** Continues the task once the limit resets at `resetsAt` (ms since epoch). */
export function scheduleResume(taskId: string, resetsAt: number): void {
  if (!autoContinueEnabled()) return
  const at = resetsAt + MARGIN_MS
  due.set(taskId, at)
  persist(taskId, at)
  arm()
}

/** Drops a pending continuation: the user took over, switched agents or deleted the task. */
export function cancelResume(taskId: string): void {
  if (!due.delete(taskId)) return
  persist(taskId, undefined)
  arm()
}

/** Picks up continuations saved before a restart. `send` delivers the message to the task. */
export function initAutoResume(send: (taskId: string, text: string) => Promise<void>): void {
  resume = send
  for (const t of getAllTasks() as { id: string; metadata: string | null }[]) {
    try {
      const at = t.metadata ? (JSON.parse(t.metadata) as { resumeAt?: unknown }).resumeAt : undefined
      if (typeof at === 'number') due.set(t.id, at)
    } catch {
      // Unreadable metadata has nothing to continue
    }
  }
  // Timers do not run while the Mac sleeps; check again on wake
  powerMonitor.on('resume', () => arm(STARTUP_DELAY_MS))
  arm(STARTUP_DELAY_MS)
}
