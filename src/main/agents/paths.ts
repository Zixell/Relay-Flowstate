import { realpathSync } from 'fs'

/** Shows paths inside the task's worktree relative to it. */
export function relativizer(cwd: string): (p: string) => string {
  const roots = new Set([cwd])
  try {
    roots.add(realpathSync(cwd))
  } catch {
    // cwd may not exist yet
  }
  // Windows paths may come with either separator, and drive letters in either case.
  const norm = (p: string): string => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p)
  return (p) => {
    const np = norm(p)
    for (const root of roots) {
      const nr = norm(root)
      if (np === nr) return '.'
      if (np.startsWith(nr + '/')) return p.slice(root.length + 1).replace(/\\/g, '/')
    }
    return p
  }
}
