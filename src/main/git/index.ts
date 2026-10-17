import { execSync, spawnSync, spawn } from 'child_process'
import os from 'os'
import fs from 'fs'
import path from 'path'

export interface GitFileChange {
  path: string
  type: 'modified' | 'added' | 'deleted' | 'renamed'
  additions: number
  deletions: number
}

export interface GitChangesResult {
  isGitRepo: boolean
  branch: string
  baseBranch: string
  files: GitFileChange[]
  committedCount: number
  isActiveBranch: boolean  // whether the task branch is currently checked out
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 8000
    }).trimEnd()
  } catch {
    return ''
  }
}

// Build env for git subprocesses — ensures SSH works from Electron on Windows
function buildGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: os.homedir() }
  if (process.platform === 'win32' && !env.SSH_AUTH_SOCK) {
    // Git for Windows' SSH (Cygwin-based) can connect to the Windows OpenSSH
    // Agent service via this named pipe — but only if SSH_AUTH_SOCK is set.
    // In a terminal session it may be inherited; in Electron it never is.
    env.SSH_AUTH_SOCK = '//./pipe/openssh-ssh-agent'
  }
  // SSH key injection is handled per-operation via git -c core.sshCommand in pushOrigin.
  // buildGitEnv is used for local operations (commit, status, merge) that don't need SSH.
  return env
}

// Runs a git command synchronously — does NOT throw
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


/**
 * Ensures the given branch exists and is checked out in `cwd`.
 * - If the branch exists locally: switches to it.
 * - If it does not exist: creates it from current HEAD.
 * Throws with a human-readable message on failure.
 */
export function ensureBranch(cwd: string, branch: string): { created: boolean } {
  const isRepo = run('git rev-parse --is-inside-work-tree', cwd)
  if (isRepo !== 'true') {
    throw new Error(`"${cwd}" is not inside a git repository`)
  }

  // Check if branch exists locally
  const exists = git(['rev-parse', '--verify', branch], cwd).success

  if (exists) {
    const checkout = git(['checkout', branch], cwd)
    if (!checkout.success) {
      throw new Error(
        `Failed to checkout branch "${branch}": ${checkout.stderr || 'unknown error'}`
      )
    }
    return { created: false }
  } else {
    const create = git(['checkout', '-b', branch], cwd)
    if (!create.success) {
      throw new Error(
        `Failed to create branch "${branch}": ${create.stderr || 'unknown error'}`
      )
    }
    return { created: true }
  }
}

function detectBaseBranch(cwd: string): string {
  // Try origin/HEAD first (most reliable)
  const originHead = run('git symbolic-ref refs/remotes/origin/HEAD --short', cwd)
  if (originHead) return originHead.replace('origin/', '')

  // Check local main / master
  if (run('git rev-parse --verify main', cwd)) return 'main'
  if (run('git rev-parse --verify master', cwd)) return 'master'
  if (run('git rev-parse --verify develop', cwd)) return 'develop'

  return ''
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>()
  for (const line of output.split('\n')) {
    const parts = line.trim().split('\t')
    if (parts.length >= 3) {
      const additions = parseInt(parts[0]) || 0
      const deletions = parseInt(parts[1]) || 0
      const path = parts[2].replace(/^"|"$/g, '')
      if (!path) continue
      const existing = map.get(path)
      if (existing) {
        map.set(path, {
          additions: Math.max(existing.additions, additions),
          deletions: Math.max(existing.deletions, deletions)
        })
      } else {
        map.set(path, { additions, deletions })
      }
    }
  }
  return map
}

export function getCurrentCommit(cwd: string): string {
  return run('git rev-parse HEAD', cwd)
}

/** Return unified diff for a single file since startCommit (or HEAD) vs working tree */
export function getFileDiff(cwd: string, filePath: string, startCommit?: string): string {
  const hasValid = startCommit ? git(['cat-file', '-e', startCommit], cwd).success : false
  const base = hasValid ? startCommit! : 'HEAD'
  const escaped = filePath.replace(/"/g, '\\"')
  return (
    run(`git diff ${base} -- "${escaped}"`, cwd) ||
    run(`git diff --cached ${base} -- "${escaped}"`, cwd) ||
    // A new file the agent has not staged: show it as fully added.
    git(['diff', '--no-index', '--', '/dev/null', filePath], cwd).stdout
  )
}

/** Line count of a new, untracked file — its "additions". Binary or huge files count as 0. */
function countLines(cwd: string, filePath: string): number {
  try {
    const full = path.join(cwd, filePath)
    if (fs.statSync(full).size > 2_000_000) return 0
    const text = fs.readFileSync(full, 'utf8')
    if (text.includes('\0')) return 0
    return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0
  } catch {
    return 0
  }
}

export interface GitWorkingFile {
  path: string
  staged: boolean
  statusCode: string
}

export interface GitWorkingStatus {
  isGitRepo: boolean
  branch: string
  files: GitWorkingFile[]
}

export function getLocalBranches(cwd: string): string[] {
  const isRepo = run('git rev-parse --is-inside-work-tree', cwd)
  if (isRepo !== 'true') return []
  const output = run('git branch --format=%(refname:short)', cwd)
  return output.split('\n').map((b) => b.trim()).filter(Boolean)
}

export function getWorkingDirStatus(cwd: string): GitWorkingStatus {
  const isRepo = run('git rev-parse --is-inside-work-tree', cwd)
  if (isRepo !== 'true') return { isGitRepo: false, branch: '', files: [] }

  const branch = run('git rev-parse --abbrev-ref HEAD', cwd)
  const statusOut = run('git status --porcelain', cwd)

  const files: GitWorkingFile[] = []
  for (const line of statusOut.split('\n')) {
    if (!line.trim()) continue
    const x = line[0]
    const y = line[1]
    const rest = line.slice(3)

    if (x === '?' && y === '?') continue

    const staged = x !== ' '
    const statusCode = staged ? x : y
    let path = rest.replace(/^"|"$/g, '')

    if (x === 'R' || y === 'R') {
      const arrowIdx = rest.indexOf(' -> ')
      if (arrowIdx !== -1) path = rest.slice(arrowIdx + 4).replace(/^"|"$/g, '')
    }

    if (path) files.push({ path, staged, statusCode })
  }

  return { isGitRepo: true, branch, files }
}

export function stageFiles(cwd: string, files: string[]): { success: boolean; stderr: string } {
  if (files.length === 0) return { success: true, stderr: '' }
  const result = git(['add', '--', ...files], cwd)
  return { success: result.success, stderr: result.stderr }
}

export function commitStaged(cwd: string, message: string): { success: boolean; stderr: string } {
  const result = git(['commit', '-m', message], cwd)
  return { success: result.success, stderr: result.stderr }
}

export async function pushOrigin(cwd: string, targetBranch?: string): Promise<{ success: boolean; stderr: string; stdout: string }> {
  const refspec = targetBranch ? `HEAD:refs/heads/${targetBranch}` : 'HEAD'
  return new Promise((resolve) => {
    const child = spawn('git', ['push', 'origin', refspec], { cwd, env: buildGitEnv(), windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => resolve({ success: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }))
    child.on('error', (err) => resolve({ success: false, stdout: '', stderr: err.message }))
  })
}

export function mergeBranch(cwd: string, branch: string, targetBranch?: string): { success: boolean; stderr: string; stdout: string } {
  if (targetBranch) {
    const checkout = git(['checkout', targetBranch], cwd)
    if (!checkout.success) {
      return { success: false, stderr: `Failed to checkout ${targetBranch}: ${checkout.stderr}`, stdout: '' }
    }
  }
  const squash = git(['merge', '--squash', branch], cwd)
  if (!squash.success) {
    return { success: false, stderr: squash.stderr, stdout: squash.stdout }
  }
  if (squash.stdout.includes('Already up to date')) {
    return { success: false, stderr: 'Nothing to merge — the task branch has no new commits. Changes may still be uncommitted.', stdout: squash.stdout }
  }
  const commit = git(['commit', '--no-edit', '-m', `Squashed: ${branch}`], cwd)
  return { success: commit.success, stderr: commit.stderr, stdout: commit.stdout }
}

export function ensureBranchExists(cwd: string, branch: string): void {
  const exists = git(['rev-parse', '--verify', branch], cwd).success
  if (!exists) {
    git(['branch', branch], cwd)
  }
}

/** Stage all changes, commit if anything staged, then merge worktree branch into targetBranch in main repo. */
export function commitAllAndMerge(
  worktreeCwd: string,
  projectCwd: string,
  targetBranch: string,
  commitMessage: string
): { success: boolean; stderr: string; committed: boolean; commitHash?: string } {
  // Stage everything in worktree
  const stageResult = git(['add', '-A'], worktreeCwd)
  if (!stageResult.success) {
    return { success: false, stderr: `Stage failed: ${stageResult.stderr}`, committed: false }
  }

  // Check if there's anything staged to commit
  const hasStagedChanges = !git(['diff', '--cached', '--quiet'], worktreeCwd).success
  let committed = false

  if (hasStagedChanges) {
    const commitResult = git(['commit', '-m', commitMessage], worktreeCwd)
    if (!commitResult.success) {
      return { success: false, stderr: `Commit failed: ${commitResult.stderr}`, committed: false }
    }
    committed = true
  }

  // Get the task's working branch from the worktree
  const taskBranch = run('git rev-parse --abbrev-ref HEAD', worktreeCwd)
  if (!taskBranch || taskBranch === 'HEAD') {
    return { success: false, stderr: 'Could not determine task branch', committed }
  }

  // Checkout target branch in main repo
  const checkoutResult = git(['checkout', targetBranch], projectCwd)
  if (!checkoutResult.success) {
    return { success: false, stderr: `Checkout ${targetBranch} failed: ${checkoutResult.stderr}`, committed }
  }

  // Squash all task-branch commits into a single staged diff (no merge commit)
  const squashResult = git(['merge', '--squash', taskBranch], projectCwd)
  if (!squashResult.success) {
    return { success: false, stderr: squashResult.stderr, committed }
  }
  if (squashResult.stdout.includes('Already up to date')) {
    return { success: false, stderr: 'Nothing to merge — no new commits on task branch', committed }
  }

  // Commit the squashed changes as one clean commit
  const squashCommit = git(['commit', '-m', commitMessage], projectCwd)
  if (!squashCommit.success) {
    return { success: false, stderr: squashCommit.stderr, committed }
  }
  const commitHash = run('git rev-parse HEAD', projectCwd)
  return { success: true, stderr: '', committed, commitHash }
}

export function getGitChanges(cwd: string, taskBranch?: string, startCommit?: string): GitChangesResult {
  const empty: GitChangesResult = {
    isGitRepo: false,
    branch: '',
    baseBranch: '',
    files: [],
    committedCount: 0,
    isActiveBranch: false
  }

  const isRepo = run('git rev-parse --is-inside-work-tree', cwd)
  if (isRepo !== 'true') return empty

  const currentBranch = run('git rev-parse --abbrev-ref HEAD', cwd)
  const targetBranch = (taskBranch && git(['rev-parse', '--verify', taskBranch], cwd).success)
    ? taskBranch
    : currentBranch
  const isActiveBranch = targetBranch === currentBranch
  const baseBranch = detectBaseBranch(cwd)

  const seenPaths = new Set<string>()
  const files: GitFileChange[] = []

  // ── COMMITTED CHANGES ───────────────────────────────────────────
  // Always diff two explicit refs: baseRef → targetBranch (branch tip, NOT working tree).
  // This scopes results to commits made on the task branch only.
  const hasValidStartCommit = startCommit
    ? git(['cat-file', '-e', startCommit], cwd).success
    : false
  const committedBase = hasValidStartCommit
    ? startCommit!
    : (baseBranch && baseBranch !== targetBranch ? baseBranch : null)

  if (committedBase) {
    const statsMap = parseNumstat(run(`git diff --numstat ${committedBase} ${targetBranch}`, cwd))

    // Use --name-status to get exact file types from committed diff
    const nameStatus = run(`git diff --name-status ${committedBase} ${targetBranch}`, cwd)
    for (const line of nameStatus.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      const code = parts[0]

      let type: GitFileChange['type'] = 'modified'
      let path: string

      if (code.startsWith('R')) {
        type = 'renamed'
        path = parts[2]?.replace(/^"|"$/g, '') ?? parts[1]?.replace(/^"|"$/g, '')
      } else if (code === 'A') {
        type = 'added'
        path = parts[1]?.replace(/^"|"$/g, '')
      } else if (code === 'D') {
        type = 'deleted'
        path = parts[1]?.replace(/^"|"$/g, '')
      } else {
        path = parts[1]?.replace(/^"|"$/g, '')
      }

      if (!path || seenPaths.has(path)) continue
      seenPaths.add(path)

      const stats = statsMap.get(path) ?? { additions: 0, deletions: 0 }
      files.push({ path, type, additions: stats.additions, deletions: stats.deletions })
    }
  }

  // ── UNCOMMITTED CHANGES (only when task branch is active) ────────
  // git diff HEAD shows staged+unstaged vs the current branch tip —
  // these are changes made during this session that aren't committed yet.
  if (isActiveBranch) {
    const uncommittedStats = new Map<string, { additions: number; deletions: number }>()
    for (const cmd of ['git diff --numstat --cached HEAD', 'git diff --numstat HEAD']) {
      for (const [p, s] of parseNumstat(run(cmd, cwd))) {
        const ex = uncommittedStats.get(p)
        uncommittedStats.set(p, ex
          ? { additions: Math.max(ex.additions, s.additions), deletions: Math.max(ex.deletions, s.deletions) }
          : s
        )
      }
    }

    // -uall lists files inside new directories one by one, like the merge's `git add -A` will.
    const statusOut = run('git status --porcelain -uall', cwd)
    for (const line of statusOut.split('\n')) {
      if (!line.trim()) continue
      const x = line[0]
      const y = line[1]
      const rest = line.slice(3)

      // New files are part of the task's work too: `git add -A` picks them up on merge.
      if (x === '?' && y === '?') {
        const newPath = rest.replace(/^"|"$/g, '')
        if (newPath && !seenPaths.has(newPath)) {
          seenPaths.add(newPath)
          files.push({ path: newPath, type: 'added', additions: countLines(cwd, newPath), deletions: 0 })
        }
        continue
      }

      let type: GitFileChange['type'] = 'modified'
      let path = rest.replace(/^"|"$/g, '')

      if (x === 'R' || y === 'R') {
        type = 'renamed'
        const arrowIdx = rest.indexOf(' -> ')
        if (arrowIdx !== -1) path = rest.slice(arrowIdx + 4).replace(/^"|"$/g, '')
      } else if (x === 'A' || y === 'A') {
        type = 'added'
      } else if (x === 'D' || y === 'D') {
        type = 'deleted'
      }

      if (!path) continue
      const stats = uncommittedStats.get(path) ?? { additions: 0, deletions: 0 }

      if (seenPaths.has(path)) {
        // File already in committed list — update stats to reflect latest state
        const existing = files.find((f) => f.path === path)
        if (existing) {
          existing.additions = Math.max(existing.additions, stats.additions)
          existing.deletions = Math.max(existing.deletions, stats.deletions)
        }
      } else {
        seenPaths.add(path)
        files.push({ path, type, additions: stats.additions, deletions: stats.deletions })
      }
    }
  }

  // Count commits on the task branch since session start
  let committedCount = 0
  if (hasValidStartCommit) {
    committedCount = parseInt(run(`git rev-list --count ${startCommit}..${targetBranch}`, cwd)) || 0
  } else if (baseBranch && targetBranch !== baseBranch) {
    committedCount = parseInt(run(`git rev-list --count ${baseBranch}..${targetBranch}`, cwd)) || 0
  }

  return { isGitRepo: true, branch: targetBranch, baseBranch, files, committedCount, isActiveBranch }
}

