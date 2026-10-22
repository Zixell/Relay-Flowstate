import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { branchesContaining, commitAllAndMerge, currentBranch, getLocalBranches } from './index'

const git = (cmd: string, cwd: string): string => execSync(`git ${cmd}`, { cwd, encoding: 'utf8' }).trim()

/** A repo on main with a develop branch, and a task worktree off main that changed a.txt without committing. */
function setup(): { repo: string; worktree: string } {
  const repo = mkdtempSync(join(tmpdir(), 'relay-merge-'))
  execSync('git init -q -b main && git config user.email t@t && git config user.name t', { cwd: repo })
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  execSync('git add -A && git commit -qm init && git branch develop', { cwd: repo })
  const worktree = join(mkdtempSync(join(tmpdir(), 'relay-merge-wt-')), 'wt')
  execSync(`git worktree add -q -b relay/task-test "${worktree}" HEAD`, { cwd: repo })
  writeFileSync(join(worktree, 'a.txt'), 'one\ntwo\n')
  return { repo, worktree }
}

describe('getLocalBranches', () => {
  it('lists every local branch, task branches included', () => {
    const { repo } = setup()
    expect(getLocalBranches(repo).sort()).toEqual(['develop', 'main', 'relay/task-test'])
    expect(currentBranch(repo)).toBe('main')
  })

  it('finds the branches that contain a commit', () => {
    const { repo } = setup()
    const init = git('rev-parse HEAD', repo)
    writeFileSync(join(repo, 'a.txt'), 'later\n')
    git('commit -qam later', repo)
    expect(branchesContaining(repo, init).sort()).toEqual(['develop', 'main', 'relay/task-test'])
    expect(branchesContaining(repo, git('rev-parse HEAD', repo))).toEqual(['main'])
  })
})

describe('commitAllAndMerge', () => {
  it('merges into an existing branch', () => {
    const { repo, worktree } = setup()
    const res = commitAllAndMerge(worktree, repo, 'develop', 'task: change a')
    expect(res.success).toBe(true)
    expect(git('rev-parse --abbrev-ref HEAD', repo)).toBe('develop')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
  })

  it('creates a missing target from the base', () => {
    const { repo, worktree } = setup()
    git('checkout -q develop', repo)
    const res = commitAllAndMerge(worktree, repo, 'release/1.0', 'release: change a', 'main')
    expect(res.success).toBe(true)
    expect(git('rev-parse --abbrev-ref HEAD', repo)).toBe('release/1.0')
    expect(git('log --format=%s', repo).split('\n')).toEqual(['release: change a', 'init'])
  })

  it('refuses a missing target without a base, before committing anything', () => {
    const { repo, worktree } = setup()
    const res = commitAllAndMerge(worktree, repo, 'release', 'msg')
    expect(res.success).toBe(false)
    expect(res.committed).toBe(false)
    expect(git('status --porcelain', worktree)).toContain('a.txt')
  })

  it('rejects an invalid branch name', () => {
    const { repo, worktree } = setup()
    const res = commitAllAndMerge(worktree, repo, 'bad..name', 'msg', 'main')
    expect(res.success).toBe(false)
    expect(res.stderr).toContain('not a valid branch name')
  })

  it('on conflict leaves the project on its branch, clean', () => {
    const { repo, worktree } = setup()
    git('checkout -q develop', repo)
    writeFileSync(join(repo, 'a.txt'), 'uno\n')
    git('commit -qam develop-edit', repo)
    git('checkout -q main', repo)

    const res = commitAllAndMerge(worktree, repo, 'develop', 'msg')
    expect(res.success).toBe(false)
    expect(res.stderr).toContain('a.txt')
    expect(git('rev-parse --abbrev-ref HEAD', repo)).toBe('main')
    expect(git('status --porcelain', repo)).toBe('')
  })

  it('explains a branch with unrelated history', () => {
    const { repo, worktree } = setup()
    git('checkout -q --orphan other', repo)
    git('rm -rqf .', repo)
    writeFileSync(join(repo, 'b.txt'), 'other\n')
    git('add -A', repo)
    git('commit -qm other-root', repo)
    git('checkout -q main', repo)

    const res = commitAllAndMerge(worktree, repo, 'other', 'msg')
    expect(res.success).toBe(false)
    expect(res.stderr).toContain('shares no history')
    expect(git('rev-parse --abbrev-ref HEAD', repo)).toBe('main')
  })
})
