import { spawnSync } from 'child_process'
import { app } from 'electron'
import { join } from 'path'
import fs from 'fs'
import os from 'os'

function buildGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: os.homedir() }
  if (process.platform === 'win32' && !env.SSH_AUTH_SOCK) {
    env.SSH_AUTH_SOCK = '//./pipe/openssh-ssh-agent'
  }
  return env
}

function git(args: string[], cwd: string): { success: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: buildGitEnv()
  })
  return {
    success: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim()
  }
}

/** Why a project cannot get isolated task worktrees. */
export type WorktreeIssue = 'not-git' | 'no-commits'

/**
 * Checks whether tasks in `repoPath` can run in their own worktree.
 * Returns null when they can. Without isolation a task works directly in the
 * user's checkout, so the UI warns about it.
 */
export function checkWorktreeSupport(repoPath: string): WorktreeIssue | null {
  if (git(['rev-parse', '--is-inside-work-tree'], repoPath).stdout !== 'true') return 'not-git'
  // A worktree branches off HEAD, which does not exist before the first commit.
  if (!git(['rev-parse', '--verify', 'HEAD'], repoPath).success) return 'no-commits'
  return null
}

/** Absolute path where all task worktrees are stored: userData/worktrees/task-<id> */
export function getWorktreePath(taskId: string): string {
  return join(app.getPath('userData'), 'worktrees', `task-${taskId}`)
}

/**
 * Creates a dedicated git worktree for a task and returns its path.
 *
 * - If `branch` exists locally → attaches the worktree to that branch.
 * - If `branch` doesn't exist → creates it from HEAD and attaches the worktree.
 * - If `branch` is omitted → creates a new branch `relay/task-<shortId>` from HEAD.
 *
 * The main repository checkout is never modified.
 * Throws with a human-readable message on failure.
 */
export function addWorktree(
  repoPath: string,
  taskId: string,
  branch?: string
): { worktreePath: string; branchCreated: boolean } {
  // Verify this is a git repository
  const isRepo = git(['rev-parse', '--is-inside-work-tree'], repoPath)
  if (isRepo.stdout !== 'true') {
    throw new Error(`"${repoPath}" is not inside a git repository`)
  }

  const worktreesRoot = join(app.getPath('userData'), 'worktrees')
  fs.mkdirSync(worktreesRoot, { recursive: true })

  const worktreePath = getWorktreePath(taskId)

  // If the worktree directory already exists (e.g. app restart), return it as-is
  if (fs.existsSync(worktreePath)) {
    return { worktreePath, branchCreated: false }
  }

  const targetBranch = branch || `relay/task-${taskId.slice(0, 8)}`
  const branchExists = git(['rev-parse', '--verify', targetBranch], repoPath).success

  let result: ReturnType<typeof git>
  let branchCreated = false

  if (branchExists) {
    // Attach worktree to the existing branch
    result = git(['worktree', 'add', worktreePath, targetBranch], repoPath)
  } else {
    // Create a new branch from HEAD and attach the worktree
    result = git(['worktree', 'add', '-b', targetBranch, worktreePath, 'HEAD'], repoPath)
    branchCreated = result.success
  }

  if (!result.success) {
    if (
      result.stderr.includes('already checked out') ||
      result.stderr.includes('is already used by worktree')
    ) {
      throw new Error(
        `Branch "${targetBranch}" is already checked out in another worktree. ` +
          `Please choose a different branch name.`
      )
    }
    throw new Error(
      `Failed to create worktree for branch "${targetBranch}": ${result.stderr || 'unknown error'}`
    )
  }

  return { worktreePath, branchCreated }
}

/**
 * Removes a git worktree and prunes stale metadata entries.
 * Pass `force: true` to remove even when there are uncommitted changes.
 */
export function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = false
): { success: boolean; stderr: string } {
  const args = ['worktree', 'remove', worktreePath]
  if (force) args.push('--force')
  const result = git(args, repoPath)
  // Prune stale refs regardless of whether remove succeeded
  git(['worktree', 'prune'], repoPath)
  return { success: result.success, stderr: result.stderr }
}
