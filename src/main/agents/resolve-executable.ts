import { spawnSync } from 'child_process'
import { existsSync } from 'fs'

const cache = new Map<string, string | null>()

/**
 * Absolute path of a CLI the user installed, or null.
 *
 * A GUI app on macOS does not inherit the user's shell PATH, so `claude` from
 * `~/.local/bin` or a version manager is invisible to a plain `spawn`. Asking a
 * login shell resolves it the same way the user's terminal would.
 */
export function resolveExecutable(name: string): string | null {
  if (cache.has(name)) return cache.get(name)!
  let found: string | null = null

  if (process.platform === 'win32') {
    const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    found = r.status === 0 ? r.stdout.split(/\r?\n/)[0]?.trim() || null : null
  } else {
    const shell = process.env.SHELL || '/bin/zsh'
    const r = spawnSync(shell, ['-lic', `command -v ${name}`], { encoding: 'utf8', timeout: 5000 })
    const line = r.stdout?.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')).pop()
    found = line && existsSync(line) ? line : null
  }

  cache.set(name, found)
  return found
}
