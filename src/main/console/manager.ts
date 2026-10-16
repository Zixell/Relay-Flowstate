import { BrowserWindow } from 'electron'
import type { IPty } from 'node-pty'

/**
 * Sidecar console: a plain shell opened in a task's worktree, like an IDE's
 * built-in terminal. It exists purely for the user's convenience — no agent is
 * launched in it, its output is never stored or parsed, and it never affects
 * the task's status, history or summary.
 */

let pty: typeof import('node-pty') | null = null
try {
  pty = require('node-pty')
} catch {
  console.warn('[relay] node-pty not available — sidecar console disabled')
}

interface ConsoleSession {
  proc: IPty
  /** Recent output, replayed when the console view re-mounts. */
  scrollback: string
}

const MAX_SCROLLBACK = 200_000
const consoles = new Map<string, ConsoleSession>()

function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

/** Opens (or re-attaches to) the task's console. Returns its scrollback. */
export function openConsole(taskId: string, cwd: string, cols: number, rows: number): { available: boolean; scrollback: string } {
  const existing = consoles.get(taskId)
  if (existing) {
    existing.proc.resize(cols, rows)
    return { available: true, scrollback: existing.scrollback }
  }
  if (!pty) return { available: false, scrollback: '' }

  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'
  const proc = pty.spawn(shell, process.platform === 'win32' ? [] : ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
  })
  const session: ConsoleSession = { proc, scrollback: '' }
  consoles.set(taskId, session)

  proc.onData((data) => {
    session.scrollback = (session.scrollback + data).slice(-MAX_SCROLLBACK)
    send(`console:data:${taskId}`, data)
  })
  proc.onExit(() => {
    consoles.delete(taskId)
    send(`console:exit:${taskId}`, null)
  })
  return { available: true, scrollback: '' }
}

export function writeConsole(taskId: string, data: string): void {
  consoles.get(taskId)?.proc.write(data)
}

export function resizeConsole(taskId: string, cols: number, rows: number): void {
  try {
    consoles.get(taskId)?.proc.resize(cols, rows)
  } catch {
    // the shell may have just exited
  }
}

export function closeConsole(taskId: string): void {
  const c = consoles.get(taskId)
  if (!c) return
  consoles.delete(taskId)
  try {
    c.proc.kill()
  } catch {
    // already gone
  }
}

export function closeAllConsoles(): void {
  for (const id of [...consoles.keys()]) closeConsole(id)
}
