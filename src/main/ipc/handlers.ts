import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import {
  getAllProjects,
  getAllTasks,
  getTaskById,
  getTaskEvents,
  getTerminalLogs,
  getTaskSummaries,
  upsertProject,
  deleteProject,
  insertTask,
  insertTaskEvent,
  updateTaskStatus,
  updateTaskNotes,
  updateTaskAgentSessionId,
  appendTaskSummary,
  deleteTask
} from '../db'
import {
  createPtySession,
  writeToPty,
  resizePty,
  killPtySession,
  getActiveSessions,
  unlockTaskStatus
} from '../pty/manager'
import {
  getAgent,
  describeAgents,
  getBoolSetting,
  isAgentAvailable,
  resolveLaunch,
  watchForNewSession,
  type AgentDefinition,
  type ResumeMode
} from '../agents'
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
  ensureBranchExists,
  commitAllAndMerge
} from '../git'
import { addWorktree, removeWorktree } from '../git/worktree'
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
  disposeSession
} from '../session/manager'
import type { UserInput } from '../agents/adapter'
import { openConsole, writeConsole, resizeConsole, closeConsole } from '../console/manager'

/** Setting that routes chat-capable agents to chat mode instead of a terminal. */
const CHAT_MODE = 'RELAY_CHAT_MODE'

// Per-task input buffer to reconstruct full lines from character-by-character PTY writes
const inputBuffers = new Map<string, string>()

/**
 * Launches — or resumes — a task's agent session.
 *
 * All agent-specific knowledge (flags, resume syntax, how the prompt is
 * delivered, where session ids come from) lives in the agent definition, so
 * this function is identical for every agent.
 */
function startAgentSession(params: {
  taskId: string
  agent: AgentDefinition
  cwd: string
  prompt?: string
  resumeSessionId?: string
  /** True when restarting an existing task (see `BuildLaunchOptions.allowContinue`). */
  allowContinue?: boolean
  cols: number
  rows: number
}): { resumed: boolean; resumeMode: ResumeMode } {
  const { taskId, agent, cwd, prompt, resumeSessionId, allowContinue, cols, rows } = params
  const launch = resolveLaunch(agent, { cwd, prompt, resumeSessionId, allowContinue })

  // Snapshot the agent's session directory BEFORE launch, then capture the id of
  // the session file it creates — that's the handle used to resume later.
  // Resuming by id keeps the original id, so this only runs when we don't have one.
  if (launch.resumeMode !== 'session-id' && agent.sessionDiscovery && agent.buildResumeCommand) {
    watchForNewSession(agent.sessionDiscovery, (sessionId) => {
      updateTaskAgentSessionId(taskId, sessionId)
    })
  }

  console.log(
    `[relay] ${agent.label} session for task ${taskId.slice(0, 8)}: ` +
      `${launch.resumeMode} — ${launch.command.cmd} ${launch.command.args.join(' ')}`
  )

  createPtySession({
    taskId,
    agentId: agent.id,
    command: launch.command,
    cwd,
    typedPrompt: launch.typedPrompt,
    cols,
    rows
  })

  return { resumed: launch.resumed, resumeMode: launch.resumeMode }
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
    (_, { projectId, title, prompt, processType, branch, cwd, model, mode, cols = 80, rows = 24 }) => {
      const id = randomUUID()

      // Create an isolated git worktree for this task so multiple tasks can run
      // in parallel without branch-switching conflicts in the main checkout.
      let worktreePath = ''
      let branchCreated = false
      if (cwd) {
        try {
          // branch is the merge TARGET — always auto-create the task's working branch
          const result = addWorktree(cwd, id)
          worktreePath = result.worktreePath
          branchCreated = result.branchCreated
        } catch (err) {
          // Non-git project: fall back to running in project dir
          console.warn('[relay] Worktree creation skipped, running in project directory:', err)
        }
        // Ensure merge target branch exists in main repo (create from HEAD if missing)
        if (branch) {
          try { ensureBranchExists(cwd, branch) } catch { /* ignore */ }
        }
      }

      // The effective working directory is the worktree (if created) or the project root
      const effectiveCwd = worktreePath || cwd || process.cwd()

      // Record the HEAD commit at session start so the Files tab can scope the diff
      const startCommit = effectiveCwd ? getCurrentCommit(effectiveCwd) : ''

      const agent = getAgent(processType)
      const transport = agent.chat && getBoolSetting(CHAT_MODE, true) ? 'chat' : 'pty'

      insertTask({
        id,
        project_id: projectId,
        title,
        prompt,
        process_type: processType,
        branch,
        worktree_path: worktreePath || undefined,
        metadata: JSON.stringify({ startCommit }),
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

      if (branch || worktreePath) {
        const worktreeNote = worktreePath ? ` (worktree: ${worktreePath})` : ''
        insertTaskEvent({
          id: randomUUID(),
          task_id: id,
          type: 'system',
          content: branchCreated
            ? `Created branch: ${branch || `relay/task-${id.slice(0, 8)}`}${worktreeNote}`
            : worktreePath
              ? `Using branch: ${branch || 'current'}${worktreeNote}`
              : `Switched to existing branch: ${branch}`
        })
      }

      if (transport === 'chat') {
        sendMessage(id, { text: prompt }).catch((err) => {
          console.error('[relay] chat session failed to start:', err)
          updateTaskStatus(id, 'failed')
          BrowserWindow.getAllWindows()[0]?.webContents.send('task:status', { taskId: id, status: 'failed' })
        })
      } else {
        startAgentSession({ taskId: id, agent, cwd: effectiveCwd, prompt, cols, rows })
      }

      return { id, projectId, title, prompt, processType, branch, status: 'running', transport }
    }
  )

  ipcMain.handle('tasks:updateStatus', (_, { id, status, runtimeSeconds, changedFilesCount }) => {
    updateTaskStatus(id, status, {
      runtime_seconds: runtimeSeconds,
      changed_files_count: changedFilesCount
    })
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

  ipcMain.handle('tasks:getEvents', (_, taskId: string) => getTaskEvents(taskId))
  ipcMain.handle('tasks:getLogs', (_, taskId: string) => getTerminalLogs(taskId))
  ipcMain.handle('tasks:delete', async (_, id: string) => {
    killPtySession(id)
    closeConsole(id)
    await disposeSession(id)
    deleteTask(id)
    return { success: true }
  })

  // --- PTY ---
  ipcMain.handle('pty:write', (_, { taskId, data }: { taskId: string; data: string }) => {
    // Buffer user input to detect complete prompts
    const buf = inputBuffers.get(taskId) ?? ''

    if (data === '\r' || data === '\n') {
      // Enter pressed — unlock status so the next agent output resumes running tracking
      unlockTaskStatus(taskId)
      // Save buffered line as user_prompt event
      const line = buf.trim()
      if (line) {
        const eventId = randomUUID()
        const now = Math.floor(Date.now() / 1000)
        insertTaskEvent({ id: eventId, task_id: taskId, type: 'user_prompt', content: line })
        emitTaskEvent({ id: eventId, task_id: taskId, type: 'user_prompt', content: line, metadata: null, timestamp: now })
      }
      inputBuffers.set(taskId, '')
    } else if (data === '\x7f' || data === '\b') {
      // Backspace
      inputBuffers.set(taskId, buf.slice(0, -1))
    } else if (data === '\x03' || data === '\x1b') {
      // Ctrl+C / Escape — discard buffer
      inputBuffers.set(taskId, '')
    } else if (!data.startsWith('\x1b')) {
      // Regular printable characters (skip escape sequences like arrow keys)
      inputBuffers.set(taskId, buf + data)
    }

    return writeToPty(taskId, data)
  })
  ipcMain.handle('pty:resize', (_, { taskId, cols, rows }) => resizePty(taskId, cols, rows))
  ipcMain.handle('pty:kill', (_, taskId: string) => {
    killPtySession(taskId)
    const task = getTaskById(taskId) as { status: string } | null
    if (task && task.status !== 'completed' && task.status !== 'failed') {
      updateTaskStatus(taskId, 'paused')
    }
    return { success: true }
  })
  ipcMain.handle('pty:sessions', () => getActiveSessions())

  ipcMain.handle('pty:restart', (_, { taskId, cols = 80, rows = 24 }: { taskId: string; cols?: number; rows?: number }) => {
    const task = getTaskById(taskId) as {
      process_type: string
      project_path: string
      worktree_path?: string
      branch?: string
      summary?: string
      agent_session_id?: string
    } | null
    if (!task) throw new Error('Task not found')

    killPtySession(taskId)

    // Use the task's worktree if it exists, otherwise fall back to the project root
    const sessionCwd = task.worktree_path || task.project_path

    // A captured session id resumes that exact conversation; without one the
    // agent may still continue the newest conversation in this working tree.
    const { resumed, resumeMode } = startAgentSession({
      taskId,
      agent: getAgent(task.process_type),
      cwd: sessionCwd,
      resumeSessionId: task.agent_session_id || undefined,
      allowContinue: true,
      cols,
      rows
    })

    updateTaskStatus(taskId, 'running')
    return { success: true, resumed, resumeMode }
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
    killPtySession(taskId)
    closeConsole(taskId)
    await disposeSession(taskId)
    deleteSnapshots(task.worktree_path, taskId)

    return removeWorktree(task.project_path, task.worktree_path, force ?? false)
  })

  // --- Chat ---
  ipcMain.handle('chat:send', (_, { taskId, input }: { taskId: string; input: UserInput }) =>
    sendMessage(taskId, input)
  )
  ipcMain.handle('chat:interrupt', (_, taskId: string) => interruptChat(taskId))
  ipcMain.handle('chat:permission', (_, { taskId, requestId, optionId }: { taskId: string; requestId: string; optionId: string }) =>
    respondPermission(taskId, requestId, optionId)
  )
  ipcMain.handle('chat:setMode', (_, { taskId, mode }: { taskId: string; mode: string }) => setChatMode(taskId, mode))
  ipcMain.handle('chat:setModel', (_, { taskId, model }: { taskId: string; model: string }) => setChatModel(taskId, model))
  ipcMain.handle(
    'chat:history',
    (_, { taskId, beforeSeq, limit }: { taskId: string; beforeSeq?: number; limit?: number }): MessageRow[] =>
      getMessages(taskId, { beforeSeq, limit })
  )
  ipcMain.handle('chat:live', (_, taskId: string) => getLiveState(taskId))

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
      const result = commitAllAndMerge(worktreeCwd, projectCwd, targetBranch, commitMessage)
      if (result.success && result.commitHash) {
        const eventId = randomUUID()
        const content = JSON.stringify({ targetBranch, commit: result.commitHash })
        const now = Math.floor(Date.now() / 1000)
        insertTaskEvent({ id: eventId, task_id: taskId, type: 'git_merge', content, metadata: null })
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
