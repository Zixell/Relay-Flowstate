import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { getSetting, setSetting } from './settings'
import { loadRenderer } from './windows'

/**
 * Floating chat windows ("picture in picture"): one task's chat in a small
 * window that stays above every other app, to follow and answer the agent
 * without switching back. One window per task.
 */

const BOUNDS_KEY = 'RELAY_PIP_BOUNDS'
const DEFAULT_SIZE = { width: 440, height: 620 }
/** How far each additional window steps from the last one. */
const CASCADE = 32

const windows = new Map<string, BrowserWindow>()

type Bounds = { x: number; y: number; width: number; height: number }

function savedBounds(): Bounds | null {
  try {
    const b = JSON.parse(getSetting(BOUNDS_KEY) || 'null') as Bounds | null
    return b && [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number') ? b : null
  } catch {
    return null
  }
}

/** Where a new window goes: where the last one was left, kept on screen, stepped aside per open window. */
function placement(): Bounds {
  const saved = savedBounds()
  const width = saved?.width ?? DEFAULT_SIZE.width
  const height = saved?.height ?? DEFAULT_SIZE.height
  const area = screen.getDisplayMatching(saved ?? { x: 0, y: 0, width, height }).workArea
  const step = windows.size * CASCADE
  // Bottom-right corner of the screen unless the user moved one before
  let x = (saved?.x ?? area.x + area.width - width - 24) - step
  let y = (saved?.y ?? area.y + area.height - height - 24) - step
  x = Math.min(Math.max(x, area.x), area.x + area.width - width)
  y = Math.min(Math.max(y, area.y), area.y + area.height - height)
  return { x, y, width: Math.min(width, area.width), height: Math.min(height, area.height) }
}

/** Opens the task's floating chat, or brings it up if it is already open. */
export function openPip(taskId: string): void {
  const open = windows.get(taskId)
  if (open && !open.isDestroyed()) {
    open.show()
    open.focus()
    return
  }

  const win = new BrowserWindow({
    ...placement(),
    minWidth: 320,
    minHeight: 280,
    frame: false,
    fullscreenable: false,
    maximizable: false,
    alwaysOnTop: true,
    backgroundColor: '#0a0a0a',
    title: 'Relay Flowstate',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  // Above ordinary windows on Windows and macOS; on macOS also on every Space
  // and over full-screen apps.
  win.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  win.on('close', () => setSetting(BOUNDS_KEY, JSON.stringify(win.getBounds())))
  win.on('closed', () => {
    if (windows.get(taskId) === win) windows.delete(taskId)
  })

  windows.set(taskId, win)
  loadRenderer(win, { pip: taskId })
}

export function closePip(taskId: string): void {
  windows.get(taskId)?.close()
}

export function closeAllPips(): void {
  for (const win of windows.values()) win.close()
}
