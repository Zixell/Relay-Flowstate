import { readdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { SessionDiscovery } from './types'

/** Canonical UUID, reused by agent definitions that name session files after one. */
export const UUID_RE_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

function scan(dir: string, pattern: RegExp, found: Set<string>): void {
  if (!existsSync(dir)) return
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scan(join(dir, entry.name), pattern, found)
      } else if (pattern.test(entry.name)) {
        found.add(join(dir, entry.name))
      }
    }
  } catch {
    /* skip unreadable paths */
  }
}

/**
 * Call BEFORE launching the agent. Snapshots the session directory, then polls
 * for a file that wasn't there before — its name carries the session id.
 *
 * Returns a stop function; the watcher also stops itself once the id is found
 * or after `timeoutMs`.
 */
export function watchForNewSession(
  discovery: SessionDiscovery,
  onFound: (sessionId: string) => void,
  timeoutMs = 120_000
): () => void {
  const { rootDir, filePattern } = discovery
  const before = new Set<string>()
  scan(rootDir, filePattern, before)

  let stopped = false
  const stop = (): void => {
    stopped = true
  }

  const hardStop = setTimeout(stop, timeoutMs)

  const poll = (): void => {
    if (stopped) {
      clearTimeout(hardStop)
      return
    }

    const current = new Set<string>()
    scan(rootDir, filePattern, current)

    for (const file of current) {
      if (before.has(file)) continue
      const name = file.split(/[\\/]/).pop() ?? ''
      const m = filePattern.exec(name)
      if (m?.[1]) {
        stopped = true
        clearTimeout(hardStop)
        onFound(m[1])
        return
      }
    }

    setTimeout(poll, 500)
  }

  setTimeout(poll, 500)
  return stop
}
