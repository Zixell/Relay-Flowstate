import { BrowserWindow, desktopCapturer, screen, shell, systemPreferences } from 'electron'

/** Long edge of a screenshot handed to the agent; larger ones get scaled down by the model anyway. */
const MAX_EDGE = 2000
const PRIVACY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

export type Screenshot = { mediaType: string; data: string } | { error: string }

const screenAllowed = (): boolean => process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted'

/**
 * A screenshot of the display the window is on, without the window itself.
 * macOS needs the Screen Recording permission: the first capture asks for it,
 * and until it is given only the wallpaper comes back.
 */
export async function captureScreenOf(win: BrowserWindow): Promise<Screenshot> {
  const display = screen.getDisplayMatching(win.getBounds())
  const size = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor)
  }
  // Leave the floating chat out of its own screenshot
  win.setContentProtection(true)
  let sources: Electron.DesktopCapturerSource[]
  try {
    await new Promise((r) => setTimeout(r, 60))
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    win.setContentProtection(false)
  }

  if (!screenAllowed()) {
    void shell.openExternal(PRIVACY_PANE)
    return {
      error:
        'macOS needs permission to take screenshots: allow Relay Flowstate in System Settings → Privacy & Security → Screen Recording, then restart the app.'
    }
  }
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) return { error: 'Could not capture the screen' }

  let image = source.thumbnail
  const { width, height } = image.getSize()
  if (Math.max(width, height) > MAX_EDGE) {
    image = width >= height ? image.resize({ width: MAX_EDGE, quality: 'good' }) : image.resize({ height: MAX_EDGE, quality: 'good' })
  }
  return { mediaType: 'image/jpeg', data: image.toJPEG(85).toString('base64') }
}
