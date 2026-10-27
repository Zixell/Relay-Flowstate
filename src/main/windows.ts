import { BrowserWindow, net } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/**
 * The app's windows: the main one, and floating chat windows (pip.ts) next to it.
 * Anything that concerns every view goes through `broadcast`; only bringing the
 * app forward targets the main window.
 */

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
}

export const getMainWindow = (): BrowserWindow | null => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)

/** Sends to every window: the main one and any floating chats. */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

/** Brings the main window up on a task. */
export function showTaskInMain(taskId: string): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('app:selectTask', taskId)
}

/** Poll until the Vite dev server is accepting connections, then load it. */
function waitAndLoadURL(win: BrowserWindow, url: string, retries = 20, delay = 300): void {
  const attempt = (): void => {
    const req = net.request(url)
    req.on('response', () => {
      win.loadURL(url)
    })
    req.on('error', () => {
      if (retries-- > 0) setTimeout(attempt, delay)
      else win.loadURL(url) // last resort — surface the real error
    })
    req.end()
  }
  attempt()
}

/** Loads the renderer; `query` picks a view (e.g. `pip` for a floating chat). */
export function loadRenderer(win: BrowserWindow, query?: Record<string, string>): void {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    waitAndLoadURL(win, url.toString())
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
}
