import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { net } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase, resetRunningTasks, resetRunningTurns, getLockedTaskIds } from './db'
import { disposeAllSessions } from './session/manager'
import { registerIpcHandlers } from './ipc/handlers'
import { killAllSessions, initLockedStatuses } from './pty/manager'
import { loadSettings } from './settings'

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

  // Window control IPC
  ipcMain.on('window:minimize', () => mainWindow.minimize())
  ipcMain.on('window:maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow.close())

  // Folder picker
  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
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
    resetRunningTasks()
    resetRunningTurns()
    initLockedStatuses(getLockedTaskIds())
    loadSettings()
  } catch (err) {
    console.warn('[relay] DB init failed (native bindings not built?):', err)
  }
  registerIpcHandlers()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  killAllSessions()
  void disposeAllSessions()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

