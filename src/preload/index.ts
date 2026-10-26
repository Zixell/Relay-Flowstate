import { contextBridge, ipcRenderer } from 'electron'

/** Where an app update stands (see main/updater.ts). */
interface UpdateState {
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'
  current: string
  version?: string
  progress?: number
  error?: string
  notesUrl?: string
  mode: 'install' | 'open' | 'page'
}

/** An agent account's plan limits, as last reported (see main/session/account-limits.ts). */
interface AccountLimits {
  limits: { label: string; usedPercent?: number; resetsAt?: number; status?: 'ok' | 'warning' | 'blocked' }[]
  updatedAt: number
}

const api = {
  /** Host OS — macOS draws native window controls, other platforms use ours. */
  platform: process.platform,

  // Window controls
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close')
  },

  // Dialogs
  dialog: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder')
  },

  // Projects
  projects: {
    getAll: () => ipcRenderer.invoke('projects:getAll'),
    create: (data: { name: string; path: string; description?: string }) =>
      ipcRenderer.invoke('projects:create', data),
    delete: (id: string) => ipcRenderer.invoke('projects:delete', id)
  },

  // Tasks
  tasks: {
    getAll: () => ipcRenderer.invoke('tasks:getAll'),
    getById: (id: string) => ipcRenderer.invoke('tasks:getById', id),
    /** The task's summaries, as a JSON array, whenever a new one is written. */
    onSummary: (taskId: string, callback: (summariesJson: string) => void) => {
      const listener = (_: Electron.IpcRendererEvent, summaries: string) => callback(summaries)
      ipcRenderer.on(`task:summary:${taskId}`, listener)
      return () => {
        ipcRenderer.removeListener(`task:summary:${taskId}`, listener)
      }
    },
    create: (data: {
      projectId: string
      title: string
      prompt: string
      processType: string
      /** false runs the agent directly in the project folder. Defaults to true. */
      worktree?: boolean
      cwd?: string
      model?: string
      mode?: string
    }) => ipcRenderer.invoke('tasks:create', data),
    updateStatus: (data: {
      id: string
      status: string
      runtimeSeconds?: number
      changedFilesCount?: number
    }) => ipcRenderer.invoke('tasks:updateStatus', data),
    updateNotes: (data: { id: string; notes: string }) =>
      ipcRenderer.invoke('tasks:updateNotes', data),
    setStarred: (id: string, starred: boolean) => ipcRenderer.invoke('tasks:setStarred', { id, starred }),
    updateSummary: (data: { id: string; summary: string }) =>
      ipcRenderer.invoke('tasks:updateSummary', data),
    getEvents: (taskId: string) => ipcRenderer.invoke('tasks:getEvents', taskId),
    getSummaries: (taskId: string) => ipcRenderer.invoke('tasks:getSummaries', taskId),
    /** The branch the task's worktree came from; a new merge target is created from it. */
    sourceBranch: (taskId: string): Promise<string | null> => ipcRenderer.invoke('tasks:sourceBranch', taskId),
    /** Writes the task's recap now; the result arrives through `onSummary`. */
    recap: (taskId: string): Promise<void> => ipcRenderer.invoke('tasks:recap', taskId),
    onEvent: (taskId: string, callback: (event: unknown) => void) => {
      const listener = (_: Electron.IpcRendererEvent, event: unknown) => callback(event)
      ipcRenderer.on(`tasks:event:${taskId}`, listener)
      return () => {
        ipcRenderer.removeListener(`tasks:event:${taskId}`, listener)
      }
    },
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id)
  },

  // Agents (catalog + per-agent capabilities and settings schema)
  agents: {
    list: () => ipcRenderer.invoke('agents:list')
  },

  // App updates from the GitHub releases (see main/updater.ts)
  updates: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke('updates:state'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onState: (callback: (state: UpdateState) => void) => {
      const listener = (_: Electron.IpcRendererEvent, s: UpdateState) => callback(s)
      ipcRenderer.on('updates:state', listener)
      return () => {
        ipcRenderer.removeListener('updates:state', listener)
      }
    }
  },

  // Plan limits (5-hour, weekly) per agent account
  limits: {
    /** Last known limits by agent id. */
    get: (): Promise<Record<string, AccountLimits>> => ipcRenderer.invoke('limits:get'),
    /** Asks the agent's CLI for its current limits; null when it cannot tell. */
    refresh: (agentId: string): Promise<AccountLimits | null> => ipcRenderer.invoke('limits:refresh', agentId)
  },

  // Settings
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', { key, value })
  },

  // Worktree management
  worktree: {
    remove: (taskId: string, force?: boolean) =>
      ipcRenderer.invoke('worktree:remove', { taskId, force })
  },

  // Git
  git: {
    getChanges: (cwd: string, branch?: string, startCommit?: string) =>
      ipcRenderer.invoke('git:getChanges', { cwd, branch, startCommit }),
    getFileDiff: (cwd: string, filePath: string, startCommit?: string) =>
      ipcRenderer.invoke('git:getFileDiff', { cwd, filePath, startCommit }),
    /** null when tasks can get their own worktree, otherwise the reason they cannot. */
    worktreeSupport: (cwd: string): Promise<'not-git' | 'no-commits' | null> =>
      ipcRenderer.invoke('git:worktreeSupport', cwd),
    getBranches: (cwd: string): Promise<string[]> =>
      ipcRenderer.invoke('git:getBranches', cwd),
    getWorkingStatus: (cwd: string) =>
      ipcRenderer.invoke('git:getWorkingStatus', cwd),
    stage: (cwd: string, files: string[]) =>
      ipcRenderer.invoke('git:stage', { cwd, files }),
    commit: (cwd: string, message: string) =>
      ipcRenderer.invoke('git:commit', { cwd, message }),
    push: (cwd: string, branch?: string) => ipcRenderer.invoke('git:push', { cwd, branch }),
    merge: (cwd: string, branch: string, targetBranch?: string) => ipcRenderer.invoke('git:merge', { cwd, branch, targetBranch }),
    /** A targetBranch that does not exist yet is created from the branch the task's worktree came from. */
    commitAndMerge: (taskId: string, worktreeCwd: string, projectCwd: string, targetBranch: string, commitMessage: string) =>
      ipcRenderer.invoke('git:commitAndMerge', { taskId, worktreeCwd, projectCwd, targetBranch, commitMessage })
  },

  // Chat mode (structured agent sessions)
  chat: {
    send: (taskId: string, input: { text: string; images?: { mediaType: string; data: string }[] }) =>
      ipcRenderer.invoke('chat:send', { taskId, input }),
    interrupt: (taskId: string) => ipcRenderer.invoke('chat:interrupt', taskId),
    fork: (taskId: string, turnId: string) => ipcRenderer.invoke('chat:fork', { taskId, turnId }),
    /** Continue the task with another agent; the next message carries the story so far. */
    switchAgent: (taskId: string, agentId: string) => ipcRenderer.invoke('chat:switchAgent', { taskId, agentId }),
    /** Commands and context for a chat without a live session, read without running a turn. */
    peek: (taskId: string) => ipcRenderer.invoke('chat:peek', taskId),
    /** Worktree files matching what follows `@` in the composer. */
    suggestFiles: (taskId: string, query: string): Promise<string[]> => ipcRenderer.invoke('chat:suggestFiles', { taskId, query }),
    /** A notification was clicked: the main process asks to show this task. */
    onSelectTask: (callback: (taskId: string) => void) => {
      const listener = (_: Electron.IpcRendererEvent, taskId: string) => callback(taskId)
      ipcRenderer.on('app:selectTask', listener)
      return () => {
        ipcRenderer.removeListener('app:selectTask', listener)
      }
    },
    /** `answers` (question text -> choice) replies to a prompt with questions. */
    respondPermission: (taskId: string, requestId: string, optionId: string, answers?: Record<string, string>) =>
      ipcRenderer.invoke('chat:permission', { taskId, requestId, optionId, answers }),
    setMode: (taskId: string, mode: string) => ipcRenderer.invoke('chat:setMode', { taskId, mode }),
    setModel: (taskId: string, model: string) => ipcRenderer.invoke('chat:setModel', { taskId, model }),
    history: (taskId: string, opts?: { beforeSeq?: number; limit?: number }) =>
      ipcRenderer.invoke('chat:history', { taskId, ...opts }),
    live: (taskId: string) => ipcRenderer.invoke('chat:live', taskId),
    /** Data URL of an image attached to a user message, or null if it is gone. */
    attachment: (taskId: string, id: string): Promise<string | null> =>
      ipcRenderer.invoke('chat:attachment', { taskId, id }),
    onEvent: (taskId: string, callback: (payload: unknown) => void) => {
      const listener = (_: Electron.IpcRendererEvent, payload: unknown) => callback(payload)
      ipcRenderer.on(`chat:event:${taskId}`, listener)
      return () => {
        ipcRenderer.removeListener(`chat:event:${taskId}`, listener)
      }
    },
    /** Lets a running command or subagent carry on in the background. */
    moveToBackground: (taskId: string, toolCallId: string): Promise<boolean> =>
      ipcRenderer.invoke('chat:moveToBackground', { taskId, toolCallId }),
    stopBackground: (taskId: string, backgroundId: string) => ipcRenderer.invoke('chat:stopBackground', { taskId, backgroundId }),
    /** Drops the automatic continuation of a task that stopped on a usage limit. */
    cancelResume: (taskId: string) => ipcRenderer.invoke('chat:cancelResume', taskId),
    /** The task's metadata after main changed it (e.g. a scheduled continuation). */
    onTaskMetadata: (callback: (payload: { taskId: string; metadata: string }) => void) => {
      const listener = (_: Electron.IpcRendererEvent, payload: { taskId: string; metadata: string }) => callback(payload)
      ipcRenderer.on('task:metadata', listener)
      return () => {
        ipcRenderer.removeListener('task:metadata', listener)
      }
    },
    /** Status changes of every chat-mode task. */
    onTaskStatus: (callback: (payload: { taskId: string; status: string; changedFilesCount?: number }) => void) => {
      const listener = (_: Electron.IpcRendererEvent, payload: { taskId: string; status: string; changedFilesCount?: number }) =>
        callback(payload)
      ipcRenderer.on('task:status', listener)
      return () => {
        ipcRenderer.removeListener('task:status', listener)
      }
    }
  },

  // Sidecar console — a plain shell in the task's worktree
  console: {
    open: (taskId: string, cols: number, rows: number): Promise<{ available: boolean; scrollback: string }> =>
      ipcRenderer.invoke('console:open', { taskId, cols, rows }),
    write: (taskId: string, data: string) => ipcRenderer.invoke('console:write', { taskId, data }),
    resize: (taskId: string, cols: number, rows: number) => ipcRenderer.invoke('console:resize', { taskId, cols, rows }),
    close: (taskId: string) => ipcRenderer.invoke('console:close', taskId),
    onData: (taskId: string, callback: (data: string) => void) => {
      const listener = (_: Electron.IpcRendererEvent, data: string) => callback(data)
      ipcRenderer.on(`console:data:${taskId}`, listener)
      return () => {
        ipcRenderer.removeListener(`console:data:${taskId}`, listener)
      }
    },
    onExit: (taskId: string, callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on(`console:exit:${taskId}`, listener)
      return () => {
        ipcRenderer.removeListener(`console:exit:${taskId}`, listener)
      }
    }
  },

  // Sessions run with the agents' own CLIs, importable as chat tasks
  sessions: {
    listExternal: () => ipcRenderer.invoke('sessions:listExternal'),
    import: (req: { agentId: string; sessionId: string; cwd: string; title: string; worktree: boolean }) =>
      ipcRenderer.invoke('sessions:import', req)
  },

  // Per-turn history of file changes
  turns: {
    list: (taskId: string) => ipcRenderer.invoke('turns:list', taskId),
    diff: (taskId: string, turnId: string, path?: string): Promise<string> =>
      ipcRenderer.invoke('turns:diff', { taskId, turnId, path }),
    revert: (taskId: string, turnId: string) => ipcRenderer.invoke('turns:revert', { taskId, turnId })
  }

}

contextBridge.exposeInMainWorld('api', api)

export type RelayAPI = typeof api

