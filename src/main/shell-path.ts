import { spawnSync } from 'child_process'
import { delimiter } from 'path'

const MARKER = '__RELAY_PATH__'

/**
 * An app opened from Finder or the Dock gets a minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), so CLIs installed with npm, nvm, Homebrew
 * or into ~/.local/bin are invisible. Read the PATH the user's login shell
 * builds and merge it into this process, before anything spawns an agent.
 */
export function adoptLoginShellPath(): void {
  if (process.platform === 'win32') return
  const shell = process.env.SHELL || '/bin/zsh'
  try {
    const r = spawnSync(shell, ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 5000,
      // An interactive shell must not wait on the terminal.
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const match = r.stdout?.match(new RegExp(`${MARKER}(.*?)${MARKER}`))
    if (!match?.[1]) return
    const merged = [...match[1].split(delimiter), ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean)
    process.env.PATH = [...new Set(merged)].join(delimiter)
  } catch (err) {
    console.warn('[relay] could not read PATH from the login shell:', err)
  }
}
