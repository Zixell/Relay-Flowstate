import { realpathSync } from 'fs'

/** Shows paths inside the task's worktree relative to it. */
export function relativizer(cwd: string): (p: string) => string {
  const roots = new Set([cwd])
  try {
    roots.add(realpathSync(cwd))
  } catch {
    // cwd may not exist yet
  }
  return (p) => {
    for (const root of roots) {
      if (p === root) return '.'
      if (p.startsWith(root + '/')) return p.slice(root.length + 1)
    }
    return p
  }
}
