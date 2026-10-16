import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): { ok: boolean; out: string } {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env }
  })
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
}

/**
 * Records the full state of a working tree — tracked, modified and untracked
 * (non-ignored) files — as a commit object, without touching the index, the
 * working tree or the branch.
 *
 * Uses a throwaway index so the user's staging area is left alone, and pins the
 * commit under `refs/relay/<taskId>/<label>` so `git gc` never collects it.
 * Returns null for non-git directories.
 */
export function snapshotWorkingTree(cwd: string, taskId: string, label: string): string | null {
  if (!git(['rev-parse', '--is-inside-work-tree'], cwd).ok) return null

  const dir = mkdtempSync(join(tmpdir(), 'relay-snap-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    const head = git(['rev-parse', '--verify', 'HEAD'], cwd)
    if (head.ok) git(['read-tree', 'HEAD'], cwd, env)
    if (!git(['add', '-A'], cwd, env).ok) return null
    const tree = git(['write-tree'], cwd, env)
    if (!tree.ok) return null

    const commitArgs = ['commit-tree', tree.out, '-m', `relay snapshot ${label}`]
    if (head.ok) commitArgs.push('-p', head.out)
    const commit = git(commitArgs, cwd, {
      GIT_AUTHOR_NAME: 'Relay',
      GIT_AUTHOR_EMAIL: 'relay@localhost',
      GIT_COMMITTER_NAME: 'Relay',
      GIT_COMMITTER_EMAIL: 'relay@localhost'
    })
    if (!commit.ok) return null

    git(['update-ref', `refs/relay/${taskId}/${label}`, commit.out], cwd)
    return commit.out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface SnapshotFileChange {
  path: string
  /** Previous path of a renamed file. */
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
}

/** Files that differ between two snapshots. */
export function diffSnapshotFiles(cwd: string, from: string, to: string): SnapshotFileChange[] {
  const numstat = git(['diff', '--numstat', '-M', from, to], cwd)
  const names = git(['diff', '--name-status', '-M', from, to], cwd)
  if (!numstat.ok || !names.ok) return []

  const counts = new Map<string, { a: number; d: number }>()
  for (const line of numstat.out.split('\n').filter(Boolean)) {
    const [a, d, ...rest] = line.split('\t')
    const path = rest[rest.length - 1]
    counts.set(path, { a: Number(a) || 0, d: Number(d) || 0 })
  }

  return names.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code, ...paths] = line.split('\t')
      const path = paths[paths.length - 1]
      const status = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : code.startsWith('R') ? 'renamed' : 'modified'
      const c = counts.get(path) ?? counts.get(paths.join(' => ')) ?? { a: 0, d: 0 }
      return {
        path,
        oldPath: status === 'renamed' ? paths[0] : undefined,
        status,
        additions: c.a,
        deletions: c.d
      } as SnapshotFileChange
    })
}

/** Unified diff of one file (or the whole tree) between two snapshots. */
export function diffSnapshots(cwd: string, from: string, to: string, path?: string): string {
  const args = ['diff', '-M', from, to]
  if (path) args.push('--', path)
  return git(args, cwd).out
}

/**
 * Puts the working tree back to a snapshot: restores every file the later
 * changes touched and removes files they created. Commits and the index are
 * left as they are, so the revert itself shows up as a working-tree change.
 */
export function restoreSnapshot(cwd: string, snapshot: string, current: string): boolean {
  const changes = diffSnapshotFiles(cwd, snapshot, current)
  const restore: string[] = []
  for (const c of changes) {
    if (c.status === 'added' || c.status === 'renamed') rmSync(join(cwd, c.path), { force: true })
    if (c.status === 'renamed' && c.oldPath) restore.push(c.oldPath)
    else if (c.status !== 'added') restore.push(c.path)
  }
  if (restore.length === 0) return true
  return git(['checkout', snapshot, '--', ...restore], cwd).ok
}

/** Drops every snapshot ref of a task. */
export function deleteSnapshots(cwd: string, taskId: string): void {
  const refs = git(['for-each-ref', '--format=%(refname)', `refs/relay/${taskId}/`], cwd)
  for (const ref of refs.out.split('\n').filter(Boolean)) git(['update-ref', '-d', ref], cwd)
}
