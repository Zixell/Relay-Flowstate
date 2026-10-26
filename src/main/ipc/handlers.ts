import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import {
  getAllProjects,
  getAllTasks,
  getTaskById,
  getTaskEvents,
  getTaskSummaries,
  upsertProject,
  deleteProject,
  insertTask,
  insertTaskEvent,
  updateTaskStatus,
  updateTaskNotes,
  setTaskStarred,
  appendTaskSummary,
  deleteTask
} from '../db'
import { getAgent, describeAgents, isAgentAvailable } from '../agents'
import {
  getGitChanges,
  getFileDiff,
  getCurrentCommit,
  getLocalBranches,
  getWorkingDirStatus,
  stageFiles,
  commitStaged,
  pushOrigin,
  mergeBranch,
  commitAllAndMerge,
  currentBranch,
  branchesContaining
} from '../git'
import { addWorktree, removeWorktree, checkWorktreeSupport } from '../git/worktree'
import { setSetting, getSettingForClient } from '../settings'
import { getMessages, getTurns, getTurn, type MessageRow } from '../db'
import { deleteSnapshots, diffSnapshotFiles, diffSnapshots, restoreSnapshot, snapshotWorkingTree } from '../git/snapshots'
import {
  sendMessage,
  interrupt as interruptChat,
  respondPermission,
  setMode as setChatMode,
  setModel as setChatModel,
  getLiveState,
  peekTask,
  switchAgent,
  disposeSession,
  moveToBackground,
  stopBackgroundTask,
  recapTask
} from '../session/manager'
import type { UserInput } from '../agents/adapter'
import { readAttachment, deleteAttachments } from '../session/attachments'
import { listImportableSessions, importSession, restoreLegacyHistory, type ImportRequest } from '../session/import'
import { forkTask } from '../session/fork'
import { cancelResume } from '../session/auto-resume'
import { getAccountLimits, refreshLimits } from '../session/account-limits'
import { suggestFiles } from '../git/files'
import { openConsole, writeConsole, resizeConsole, closeConsole } from '../console/manager'

function worktreeIssueText(issue?: string): string {
  if (issue === 'not-git') return 'the project is not a git repository'
  if (issue === 'no-commits') return 'the repository has no commits yet'
  return issue || 'worktree could not be created'
}

/**
 * The branch a task's worktree came from, which a new merge target is created from.
 * Tasks from before it was recorded get the likeliest branch that contains their start commit.
 */
function taskSourceBranch(task: { project_path: string; branch?: string | null; metadata: string | null }): string | undefined {
  let meta: { sourceBranch?: string; startCommit?: string } = {}
  try { meta = task.metadata ? JSON.parse(task.metadata) : {} } catch { /* none recorded */ }
  const local = getLocalBranches(task.project_path).filter((b) => !b.startsWith('relay/task-'))
  if (meta.sourceBranch && local.includes(meta.sourceBranch)) return meta.sourceBranch
  if (!meta.startCommit) return undefined
  const containing = branchesContaining(task.project_path, meta.startCommit).filter((b) => local.includes(b))
  const preferred = [task.branch, currentBranch(task.project_path), 'main', 'master', 'develop']
  return preferred.find((b) => b && containing.includes(b)) ?? containing[0]
}

function emitTaskEvent(event: { id: string; task_id: string; type: string; content: string; metadata: string | null; timestamp?: number }): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    win.webContents.send(`tasks:event:${event.task_id}`, event)
  }
}

export function registerIpcHandlers(): void {
  // --- Projects ---
  ipcMain.handle('projects:getAll', () => getAllProjects())
  ipcMain.handle('projects:create', (_, { name, path, description }) => {
    const id = randomUUID()
    const project = upsertProject({ id, name, path, description })
    return project
  })
  ipcMain.handle('projects:delete', (_, id: string) => {
    deleteProject(id)
    return { success: true }
  })

  // --- Tasks ---
  ipcMain.handle('tasks:getAll', () => getAllTasks())
  ipcMain.handle('tasks:getById', (_, id: string) => getTaskById(id))
  ipcMain.handle(
    'tasks:create',
    (_, { projectId, title, prompt, processType, worktree = true, cwd, model, mode }) => {
      // Fail before creating a worktree for an agent that cannot run.
      const agent = getAgent(processType)
      if (!agent.chat) throw new Error(`${agent.label} is not supported`)
      const id = randomUUID()

      // Create an isolated git worktree for this task so multiple tasks can run
      // in parallel without branch-switching conflicts in the main checkout.
      let worktreePath = ''
      let branchCreated = false
      // The project's branch the worktree starts from; a new merge target is created from it
      let sourceBranch: string | undefined
      // Recorded on the task so the UI can say why it is not isolated.
      let worktreeIssue: string | undefined
      if (cwd && worktree) {
        worktreeIssue = checkWorktreeSupport(cwd) ?? undefined
        if (!worktreeIssue) {
          try {
            // The merge target is chosen later, when merging
            sourceBranch = currentBranch(cwd)
            const result = addWorktree(cwd, id)
            worktreePath = result.worktreePath
            branchCreated = result.branchCreated
          } catch (err) {
            console.warn('[relay] Worktree creation failed, running in project directory:', err)
            worktreeIssue = err instanceof Error ? err.message : String(err)
          }
        }
      }

      // The effective working directory is the worktree (if created) or the project root
      const effectiveCwd = worktreePath || cwd || process.cwd()

      // Record the HEAD commit at session start so the Files tab can scope the diff
      const startCommit = effectiveCwd ? getCurrentCommit(effectiveCwd) : ''

      const transport = 'chat'

      insertTask({
        id,
        project_id: projectId,
        title,
        prompt,
        process_type: processType,
        worktree_path: worktreePath || undefined,
        // worktree: false marks a deliberate opt-out, which needs no warning
        metadata: JSON.stringify({ startCommit, sourceBranch, worktreeIssue, ...(worktree ? {} : { worktree: false }) }),
        transport,
        model,
        mode
      })

      const eventId = randomUUID()
      insertTaskEvent({
        id: eventId,
        task_id: id,
        type: 'user_prompt',
        content: prompt,
        metadata: JSON.stringify({ processType })
      })

      if (cwd && !worktreePath) {
        insertTaskEvent({
          id: randomUUID(),
          task_id: id,
          type: 'system',
          content: worktree
            ? `No isolated worktree — the agent works directly in ${cwd} (${worktreeIssueText(worktreeIssue)})`
            : `No worktree — the agent works directly in ${cwd}`
        })
      }

      if (worktreePath) {
        insertTaskEvent({
          id: randomUUID(),
          task_id: id,
          type: 'system',
          content: `${branchCreated ? 'Created' : 'Using'} branch: relay/task-${id.slice(0, 8)}${sourceBranch ? ` from ${sourceBranch}` : ''} (worktree: ${worktreePath})`
        })
      }

      sendMessage(id, { text: prompt }).catch((err) => {
        console.error('[relay] chat session failed to start:', err)
        updateTaskStatus(id, 'failed')
        BrowserWindow.getAllWindows()[0]?.webContents.send('task:status', { taskId: id, status: 'failed' })
      })

      return { id, projectId, title, prompt, processType, status: 'running', transport }
    }
  )

  ipcMain.handle('tasks:updateStatus', (_, { id, status, runtimeSeconds, changedFilesCount }) => {
    updateTaskStatus(id, status, {
      runtime_seconds: runtimeSeconds,
      changed_files_count: changedFilesCount
    })
    return { success: true }
  })

  ipcMain.handle('tasks:setStarred', (_, { id, starred }: { id: string; starred: boolean }) => {
    setTaskStarred(id, starred)
    return { success: true }
  })

  ipcMain.handle('tasks:updateNotes', (_, { id, notes }) => {
    updateTaskNotes(id, notes)
    return { success: true }
  })

  ipcMain.handle('tasks:updateSummary', (_, { id, summary }: { id: string; summary: string }) => {
    appendTaskSummary(id, summary)
    return { success: true }
  })

  ipcMain.handle('tasks:getSummaries', (_, taskId: string) => {
    const rows = getTaskSummaries(taskId)
    return rows.map((r) => ({ ...JSON.parse(r.summary_json), _created_at: r.created_at }))
  })

  ipcMain.handle('tasks:recap', (_, taskId: string) => recapTask(taskId))
  ipcMain.handle('tasks:sourceBranch', (_, taskId: string) => {
    const task = getTaskById(taskId) as { project_path: string; branch?: string | null; metadata: string | null } | null
    return (task && taskSourceBranch(task)) ?? null
  })

  ipcMain.handle('tasks:getEvents', (_, taskId: string) => getTaskEvents(taskId))
  ipcMain.handle('tasks:delete', async (_, id: string) => {
    cancelResume(id)
    closeConsole(id)
    await disposeSession(id)
    deleteAttachments(id)
    deleteTask(id)
    return { success: true }
  })


  // --- Worktree ---
  ipcMain.handle('worktree:remove', async (_, { taskId, force }: { taskId: string; force?: boolean }) => {
    const task = getTaskById(taskId) as {
      project_path: string
      worktree_path?: string
      status: string
    } | null
    if (!task) throw new Error('Task not found')
    if (!task.worktree_path) return { success: true, message: 'No worktree associated with this task' }

    // Stop any running session first
    closeConsole(taskId)
    await disposeSession(taskId)
    deleteSnapshots(task.worktree_path, taskId)

    return removeWorktree(task.project_path, task.worktree_path, force ?? false)
  })

  // --- Chat ---
  ipcMain.handle('chat:fork', (_, { taskId, turnId }: { taskId: string; turnId: string }) => forkTask(taskId, turnId))
  ipcMain.handle('chat:switchAgent', (_, { taskId, agentId }: { taskId: string; agentId: string }) => switchAgent(taskId, agentId))
  ipcMain.handle('chat:send', (_, { taskId, input }: { taskId: string; input: UserInput }) => {
    // Follow-ups show up on the timeline like the initial prompt (logged by tasks:create).
    if (input.text.trim()) {
      const event = { id: randomUUID(), task_id: taskId, type: 'user_prompt', content: input.text }
      insertTaskEvent(event)
      emitTaskEvent({ ...event, metadata: null, timestamp: Math.floor(Date.now() / 1000) })
    }
    return sendMessage(taskId, input)
  })
  ipcMain.handle('chat:interrupt', (_, taskId: string) => interruptChat(taskId))
  ipcMain.handle('chat:cancelResume', (_, taskId: string) => cancelResume(taskId))
  ipcMain.handle('chat:moveToBackground', (_, { taskId, toolCallId }: { taskId: string; toolCallId: string }) =>
    moveToBackground(taskId, toolCallId)
  )
  ipcMain.handle('chat:stopBackground', (_, { taskId, backgroundId }: { taskId: string; backgroundId: string }) =>
    stopBackgroundTask(taskId, backgroundId)
  )
  ipcMain.handle(
    'chat:permission',
    (_, { taskId, requestId, optionId, answers }: { taskId: string; requestId: string; optionId: string; answers?: Record<string, string> }) =>
      respondPermission(taskId, requestId, optionId, answers)
  )
  ipcMain.handle('chat:setMode', (_, { taskId, mode }: { taskId: string; mode: string }) => setChatMode(taskId, mode))
  ipcMain.handle('chat:setModel', (_, { taskId, model }: { taskId: string; model: string }) => setChatModel(taskId, model))
  ipcMain.handle(
    'chat:history',
    async (_, { taskId, beforeSeq, limit }: { taskId: string; beforeSeq?: number; limit?: number }): Promise<MessageRow[]> => {
      await restoreLegacyHistory(taskId)
      return getMessages(taskId, { beforeSeq, limit })
    }
  )
  ipcMain.handle('chat:live', (_, taskId: string) => getLiveState(taskId))
  ipcMain.handle('chat:peek', (_, taskId: string) => peekTask(taskId))
  ipcMain.handle('chat:suggestFiles', (_, { taskId, query }: { taskId: string; query: string }) => {
    const task = getTaskById(taskId) as { worktree_path?: string; project_path: string } | null
    return task ? suggestFiles(task.worktree_path || task.project_path, query) : []
  })
  ipcMain.handle('chat:attachment', (_, { taskId, id }: { taskId: string; id: string }) => readAttachment(taskId, id))

  // --- Sidecar console (plain shell in the task's worktree, no agent logic) ---
  ipcMain.handle('console:open', (_, { taskId, cols, rows }: { taskId: string; cols: number; rows: number }) => {
    const task = getTaskById(taskId) as { worktree_path?: string; project_path: string } | null
    if (!task) throw new Error('Task not found')
    return openConsole(taskId, task.worktree_path || task.project_path, cols, rows)
  })
  ipcMain.handle('console:write', (_, { taskId, data }: { taskId: string; data: string }) => writeConsole(taskId, data))
  ipcMain.handle('console:resize', (_, { taskId, cols, rows }: { taskId: string; cols: number; rows: number }) =>
    resizeConsole(taskId, cols, rows)
  )
  ipcMain.handle('console:close', (_, taskId: string) => closeConsole(taskId))

  // --- Sessions started outside the app (agent CLIs) ---
  ipcMain.handle('sessions:listExternal', () => listImportableSessions())
  ipcMain.handle('sessions:import', (_, req: ImportRequest) => importSession(req))

  // --- Turns (per-turn history of file changes) ---
  ipcMain.handle('turns:list', (_, taskId: string) => {
    const task = getTaskById(taskId) as { worktree_path?: string; project_path: string } | null
    if (!task) return []
    const cwd = task.worktree_path || task.project_path
    return getTurns(taskId).map((t) => ({
      ...t,
      files: t.commit_before && t.commit_after ? diffSnapshotFiles(cwd, t.commit_before, t.commit_after) : []
    }))
  })
  ipcMain.handle('turns:diff', (_, { taskId, turnId, path }: { taskId: string; turnId: string; path?: string }) => {
    const task = getTaskById(taskId) as { worktree_path?: string; project_path: string } | null
    const turn = getTurn(turnId)
    if (!task || !turn?.commit_before || !turn.commit_after) return ''
    return diffSnapshots(task.worktree_path || task.project_path, turn.commit_before, turn.commit_after, path)
  })
  ipcMain.handle('turns:revert', (_, { taskId, turnId }: { taskId: string; turnId: string }) => {
    const task = getTaskById(taskId) as { worktree_path?: string; project_path: string } | null
    const turn = getTurn(turnId)
    if (!task || !turn?.commit_before) return { success: false, error: 'Nothing to revert to' }
    const cwd = task.worktree_path || task.project_path
    const current = snapshotWorkingTree(cwd, taskId, `revert-${Date.now()}`)
    if (!current) return { success: false, error: 'Not a git repository' }
    const ok = restoreSnapshot(cwd, turn.commit_before, current)
    insertTaskEvent({
      id: randomUUID(),
      task_id: taskId,
      type: 'system',
      content: ok ? 'Reverted files to the state before a turn' : 'Revert failed',
      metadata: JSON.stringify({ turnId })
    })
    return { success: ok }
  })

  // --- Agents ---
  ipcMain.handle('agents:list', () => describeAgents())
  ipcMain.handle('limits:get', () => getAccountLimits())
  ipcMain.handle('limits:refresh', (_, agentId: string) => refreshLimits(agentId))

  // --- Settings ---
  ipcMain.handle('settings:get', (_, key: string) => {
    // Legacy key kept so older renderer builds keep working
    if (key === 'CLAUDE_CLI_AVAILABLE') return String(isAgentAvailable('claude-code'))
    return getSettingForClient(key)
  })
  ipcMain.handle('settings:getAll', () => {
    return { CLAUDE_CLI_AVAILABLE: String(isAgentAvailable('claude-code')) }
  })
  ipcMain.handle('settings:set', (_, { key, value }: { key: string; value: string }) => {
    setSetting(key, value)
    return { success: true }
  })

  // --- Git ---
  ipcMain.handle('git:worktreeSupport', (_, cwd: string) => checkWorktreeSupport(cwd))
  ipcMain.handle('git:getBranches', (_, cwd: string) => getLocalBranches(cwd))
  ipcMain.handle('git:getWorkingStatus', (_, cwd: string) => getWorkingDirStatus(cwd))
  ipcMain.handle('git:stage', (_, { cwd, files }: { cwd: string; files: string[] }) =>
    stageFiles(cwd, files)
  )
  ipcMain.handle('git:commit', (_, { cwd, message }: { cwd: string; message: string }) =>
    commitStaged(cwd, message)
  )
  ipcMain.handle('git:push', (_, { cwd, branch }: { cwd: string; branch?: string }) => pushOrigin(cwd, branch))
  ipcMain.handle('git:merge', (_, { cwd, branch, targetBranch }: { cwd: string; branch: string; targetBranch?: string }) =>
    mergeBranch(cwd, branch, targetBranch)
  )

  ipcMain.handle(
    'git:commitAndMerge',
    (_, { taskId, worktreeCwd, projectCwd, targetBranch, commitMessage }: {
      taskId: string
      worktreeCwd: string
      projectCwd: string
      targetBranch: string
      commitMessage: string
    }) => {
      // A new target branch comes off the branch the worktree was created from
      const task = getTaskById(taskId) as { project_path: string; branch?: string | null; metadata: string | null } | null
      const result = commitAllAndMerge(worktreeCwd, projectCwd, targetBranch, commitMessage, task ? taskSourceBranch(task) : undefined)
      if (result.success && result.commitHash) {
        const eventId = randomUUID()
        const content = JSON.stringify({ targetBranch, commit: result.commitHash })
        const now = Math.floor(Date.now() / 1000)
        insertTaskEvent({ id: eventId, task_id: taskId, type: 'git_merge', content })
        emitTaskEvent({ id: eventId, task_id: taskId, type: 'git_merge', content, metadata: null, timestamp: now })
      }
      return result
    }
  )

  ipcMain.handle(
    'git:getChanges',
    (_, { cwd, branch, startCommit }: { cwd: string; branch?: string; startCommit?: string }) =>
      getGitChanges(cwd, branch, startCommit)
  )

  ipcMain.handle(
    'git:getFileDiff',
    (_, { cwd, filePath, startCommit }: { cwd: string; filePath: string; startCommit?: string }) =>
      getFileDiff(cwd, filePath, startCommit)
  )
}
