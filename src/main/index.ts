import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { net } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase, resetRunningTasks, resetRunningTurns, convertLegacyTasks } from './db'
import { disposeAllSessions } from './session/manager'
import { closeAllConsoles } from './console/manager'
import { registerIpcHandlers } from './ipc/handlers'
import { loadSettings } from './settings'

// Lets tests and parallel dev instances run against their own database and worktrees.
if (process.env.RELAY_USER_DATA) app.setPath('userData', process.env.RELAY_USER_DATA)

/** Poll until the Vite dev server is accepting connections, then load it. */
function waitAndLoadURL(win: BrowserWindow, url: string, retries = 20, delay = 300): void {
  const attempt = () => {
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

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    waitAndLoadURL(mainWindow, process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

}

/**
 * Window-level IPC. Registered once per app run, not per window: on macOS the
 * window is re-created from the dock (`activate`), and registering a handler
 * twice throws. Each call acts on the window that sent it.
 */
function registerWindowHandlers(): void {
  const senderWindow = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null =>
    BrowserWindow.fromWebContents(e.sender)

  ipcMain.on('window:minimize', (e) => senderWindow(e)?.minimize())
  ipcMain.on('window:maximize', (e) => {
    const win = senderWindow(e)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', (e) => senderWindow(e)?.close())

  // Folder picker
  ipcMain.handle('dialog:openFolder', async (e) => {
    const win = senderWindow(e)
    const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.relay.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    initDatabase()
    const converted = convertLegacyTasks()
    if (converted) console.log(`[relay] converted ${converted} terminal task(s) to chat`)
    resetRunningTasks()
    resetRunningTurns()
    loadSettings()
  } catch (err) {
    console.warn('[relay] DB init failed (native bindings not built?):', err)
  }
  registerIpcHandlers()
  registerWindowHandlers()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void disposeAllSessions()
  closeAllConsoles()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

