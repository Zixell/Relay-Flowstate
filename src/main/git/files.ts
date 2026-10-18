import { spawnSync } from 'child_process'

const cache = new Map<string, { files: string[]; at: number }>()
const TTL_MS = 10_000

/** Files in the worktree that git knows or would add (tracked + untracked, minus ignored). */
function listFiles(cwd: string): string[] {
  const hit = cache.get(cwd)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.files
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024 * 1024
  })
  const files = r.status === 0 ? [...new Set(r.stdout.split('\n').filter(Boolean))] : []
  cache.set(cwd, { files, at: Date.now() })
  return files
}

/**
 * Scores a path against what was typed after `@`: every character must appear
 * in order; matches in the file name, at word starts and in runs score higher.
 * Returns -1 when it does not match.
 */
export function scorePath(path: string, query: string): number {
  if (!query) return 1000 - path.length
  const p = path.toLowerCase()
  const q = query.toLowerCase()
  const nameStart = p.lastIndexOf('/') + 1
  let score = 0
  let from = 0
  let prev = -2
  for (const ch of q) {
    const i = p.indexOf(ch, from)
    if (i < 0) return -1
    if (i === prev + 1) score += 5
    if (i >= nameStart) score += 3
    if (i === 0 || '/._-'.includes(p[i - 1])) score += 4
    prev = i
    from = i + 1
  }
  if (p.slice(nameStart).startsWith(q)) score += 25
  if (p.includes(q)) score += 15
  return score * 100 - path.length
}

/** Best matches for an `@` mention, for the composer's file menu. */
export function suggestFiles(cwd: string, query: string, limit = 20): string[] {
  return listFiles(cwd)
    .map((f) => ({ f, s: scorePath(f, query) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f)
}
