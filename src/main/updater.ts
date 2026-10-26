import { app, BrowserWindow, shell } from 'electron'
import { createWriteStream } from 'fs'
import { join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

/**
 * Updates from the GitHub releases.
 *
 * Windows installs them in place through electron-updater. macOS cannot: the
 * builds are not signed with a Developer ID, and Squirrel.Mac refuses an
 * update it cannot verify. There the new .dmg is downloaded and opened, and the
 * user drags the app into Applications.
 */

const REPO = 'Zixell/Relay-Flowstate'
const RELEASES_URL = `https://github.com/${REPO}/releases`

export type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'

export interface UpdateState {
  status: UpdateStatus
  current: string
  /** The newer version, once one is found. */
  version?: string
  /** 0–100 while downloading. */
  progress?: number
  error?: string
  /** Where to read about the release. */
  notesUrl?: string
  /** 'install' replaces the app and restarts (Windows); 'open' opens the downloaded .dmg (macOS); 'page' only links the release. */
  mode: 'install' | 'open' | 'page'
}

const mode: UpdateState['mode'] = !app.isPackaged ? 'page' : process.platform === 'win32' ? 'install' : process.platform === 'darwin' ? 'open' : 'page'
let state: UpdateState = { status: 'idle', current: app.getVersion(), mode }
/** The .dmg of this Mac's architecture in the latest release. */
let dmg: { url: string; name: string } | null = null
let downloadedDmg: string | null = null

function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('updates:state', state)
}

export const getUpdateState = (): UpdateState => state

/** Numeric x.y.z comparison; a leading "v" is ignored. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0)
  const [a, b] = [parse(candidate), parse(current)]
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

/** electron-updater is loaded only where it is used, so macOS never starts Squirrel. */
async function winUpdater(): Promise<typeof import('electron-updater').autoUpdater> {
  const { autoUpdater } = await import('electron-updater')
  return autoUpdater
}

let winListeners = false

export async function checkForUpdates(): Promise<UpdateState> {
  if (state.status === 'checking' || state.status === 'downloading') return state
  set({ status: 'checking', error: undefined })
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const release = (await res.json()) as { tag_name: string; html_url: string; assets: { name: string; browser_download_url: string }[] }
    const version = release.tag_name.replace(/^v/, '')
    if (!isNewer(version, state.current)) {
      set({ status: 'up-to-date', version: undefined, notesUrl: undefined })
      return state
    }
    const asset = release.assets.find((a) => a.name.endsWith(`-mac-${process.arch}.dmg`))
    dmg = asset ? { url: asset.browser_download_url, name: asset.name } : null
    // Already downloaded this session: nothing more to fetch
    if (state.status === 'ready' && state.version === version) return state
    set({ status: 'available', version, notesUrl: release.html_url, progress: undefined })
    // Windows fetches the installer in the background right away
    if (state.mode === 'install') void downloadUpdate()
  } catch (err) {
    set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
  }
  return state
}

export async function downloadUpdate(): Promise<void> {
  if (state.status !== 'available') return
  if (state.mode === 'page') return
  set({ status: 'downloading', progress: 0 })
  try {
    if (state.mode === 'install') {
      const updater = await winUpdater()
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = true
      if (!winListeners) {
        winListeners = true
        updater.on('download-progress', (p) => set({ progress: Math.round(p.percent) }))
      }
      const result = await updater.checkForUpdates()
      if (!result?.updateInfo || !isNewer(result.updateInfo.version, state.current)) throw new Error('The release has no Windows update yet')
      await updater.downloadUpdate()
      set({ status: 'ready', progress: 100 })
      return
    }
    if (!dmg) throw new Error(`The release has no installer for this Mac (${process.arch})`)
    const res = await fetch(dmg.url)
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
    const total = Number(res.headers.get('content-length')) || 0
    let received = 0
    const target = join(app.getPath('downloads'), dmg.name)
    const counted = Readable.fromWeb(res.body as import('stream/web').ReadableStream<Uint8Array>)
    counted.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (total) set({ progress: Math.round((received / total) * 100) })
    })
    await pipeline(counted, createWriteStream(target))
    downloadedDmg = target
    set({ status: 'ready', progress: 100 })
  } catch (err) {
    set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}

/** Windows: quits and runs the installer. macOS: opens the .dmg and quits, so the app can be replaced. */
export async function installUpdate(): Promise<void> {
  if (state.mode === 'page' || state.status !== 'ready') {
    await shell.openExternal(state.notesUrl ?? RELEASES_URL)
    return
  }
  if (state.mode === 'install') {
    ;(await winUpdater()).quitAndInstall()
    return
  }
  if (!downloadedDmg) return
  const error = await shell.openPath(downloadedDmg)
  if (error) {
    set({ status: 'error', error })
    return
  }
  // A running app cannot be replaced; leave the window for the drag into Applications
  setTimeout(() => app.quit(), 1500)
}

/** A quiet check shortly after launch, in packaged builds only. */
export function startUpdateChecks(): void {
  if (!app.isPackaged) return
  setTimeout(() => void checkForUpdates(), 15_000)
}
