import { readdirSync, statSync } from 'fs'
import { isAbsolute, join, relative, sep } from 'path'
import type { AgentEvent } from '../agents/adapter'
import { diffSnapshotFiles, snapshotWorkingTree } from '../git/snapshots'

/**
 * What the worktree looked like at a moment, to tell which files a step changed.
 * A git snapshot where there is git; elsewhere a scan of sizes and modification
 * times. Null when neither works (a tree too big to scan).
 */
export type TreeState = { kind: 'git'; commit: string } | { kind: 'scan'; files: Map<string, string> } | null

/** Heavy directories no step's change is looked for in. */
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.gradle', '.next', '.turbo', '.cache', 'target', 'Pods', 'DerivedData'])
const MAX_FILES = 50_000

export function captureTree(cwd: string, taskId: string, label: string): TreeState {
  const commit = snapshotWorkingTree(cwd, taskId, label)
  if (commit) return { kind: 'git', commit }
  return scanTree(cwd)
}

export function scanTree(root: string): TreeState {
  const files = new Map<string, string>()
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      const path = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(path)
      } else if (e.isFile()) {
        if (files.size >= MAX_FILES) return null
        try {
          const st = statSync(path)
          files.set(relative(root, path), `${st.size}:${st.mtimeMs}`)
        } catch {
          // gone meanwhile
        }
      }
    }
  }
  return { kind: 'scan', files }
}

/** Files added, changed or removed between two states, sorted. */
export function changedBetween(cwd: string, before: TreeState, after: TreeState): string[] {
  if (before?.kind === 'git' && after?.kind === 'git') return diffSnapshotFiles(cwd, before.commit, after.commit).map((f) => f.path)
  if (before?.kind !== 'scan' || after?.kind !== 'scan') return []
  const changed = new Set<string>()
  for (const [path, sig] of after.files) if (before.files.get(path) !== sig) changed.add(path)
  for (const path of before.files.keys()) if (!after.files.has(path)) changed.add(path)
  return [...changed].sort()
}

/** Files an agent's finished edit says it changed — catches what a scan cannot (a tree too big to scan). */
export function pathsTouchedBy(e: AgentEvent, cwd: string): string[] {
  if (e.type !== 'tool.completed' || e.status !== 'ok') return []
  return (e.diff ?? []).map((d) => (isAbsolute(d.path) && d.path.startsWith(cwd + sep) ? relative(cwd, d.path) : d.path))
}
