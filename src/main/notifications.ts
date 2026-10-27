import { app, BrowserWindow, Notification } from 'electron'
import { getBoolSetting } from './agents'
import { showTaskInMain } from './windows'

export const NOTIFICATIONS = 'RELAY_NOTIFICATIONS'

/**
 * A system notification about a task, shown only while the app is in the
 * background — in the foreground the task list already shows the change.
 * Clicking it brings the window up on that task.
 */
export function notifyTask(taskId: string, title: string, body: string): void {
  if (!getBoolSetting(NOTIFICATIONS, true) || !Notification.isSupported()) return
  if (BrowserWindow.getAllWindows().some((w) => w.isFocused())) return
  const n = new Notification({ title, body: body.length > 180 ? body.slice(0, 177) + '…' : body })
  n.on('click', () => showTaskInMain(taskId))
  n.show()
}

/** Number of tasks waiting for the user, on the dock icon (macOS) or taskbar (others). */
export function setAttentionCount(count: number): void {
  if (process.platform === 'darwin') app.dock?.setBadge(count > 0 ? String(count) : '')
  else app.setBadgeCount(count)
}
