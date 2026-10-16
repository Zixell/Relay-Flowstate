import { describe, expect, it } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { snapshotWorkingTree, diffSnapshotFiles, restoreSnapshot, deleteSnapshots } from './snapshots'

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-snap-test-'))
  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  writeFileSync(join(dir, 'b.txt'), 'bee\n')
  execSync('git add -A && git commit -qm init', { cwd: dir })
  return dir
}

describe('snapshots', () => {
  it('captures untracked files without touching the index', () => {
    const dir = repo()
    writeFileSync(join(dir, 'new.txt'), 'fresh\n')
    const before = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' })
    const snap = snapshotWorkingTree(dir, 'task1', '1-after')
    expect(snap).toMatch(/^[0-9a-f]{40}$/)
    expect(execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' })).toBe(before)
    expect(execSync(`git show ${snap}:new.txt`, { cwd: dir, encoding: 'utf8' })).toBe('fresh\n')
  })

  it('diffs and restores a turn', () => {
    const dir = repo()
    const before = snapshotWorkingTree(dir, 't', '1-before')!
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    writeFileSync(join(dir, 'c.txt'), 'sea\n')
    renameSync(join(dir, 'b.txt'), join(dir, 'b2.txt'))
    const after = snapshotWorkingTree(dir, 't', '1-after')!

    const files = diffSnapshotFiles(dir, before, after)
    expect(files.map((f) => `${f.status}:${f.path}`).sort()).toEqual(['added:c.txt', 'modified:a.txt', 'renamed:b2.txt'])

    expect(restoreSnapshot(dir, before, after)).toBe(true)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n')
    expect(existsSync(join(dir, 'c.txt'))).toBe(false)
    expect(existsSync(join(dir, 'b2.txt'))).toBe(false)
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('bee\n')

    deleteSnapshots(dir, 't')
    expect(execSync('git for-each-ref refs/relay/', { cwd: dir, encoding: 'utf8' })).toBe('')
  })

  it('returns null outside git', () => {
    expect(snapshotWorkingTree(mkdtempSync(join(tmpdir(), 'nogit-')), 't', 'x')).toBeNull()
  })
})
