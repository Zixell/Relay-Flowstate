import { describe, expect, it, vi } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
const { checkWorktreeSupport } = await import('./worktree')

const dir = (): string => mkdtempSync(join(tmpdir(), 'relay-wt-'))

describe('checkWorktreeSupport', () => {
  it('flags folders that are not git repositories', () => {
    expect(checkWorktreeSupport(dir())).toBe('not-git')
  })

  it('flags repositories without commits', () => {
    const d = dir()
    execSync('git init -q', { cwd: d })
    expect(checkWorktreeSupport(d)).toBe('no-commits')
  })

  it('accepts a repository with a commit', () => {
    const d = dir()
    execSync('git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: d })
    expect(checkWorktreeSupport(d)).toBeNull()
  })
})
