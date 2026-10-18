import { contextBridge, ipcRenderer } from 'electron'

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
      branch?: string
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
    updateSummary: (data: { id: string; summary: string }) =>
      ipcRenderer.invoke('tasks:updateSummary', data),
    getEvents: (taskId: string) => ipcRenderer.invoke('tasks:getEvents', taskId),
    getSummaries: (taskId: string) => ipcRenderer.invoke('tasks:getSummaries', taskId),
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
    commitAndMerge: (taskId: string, worktreeCwd: string, projectCwd: string, targetBranch: string, commitMessage: string) =>
      ipcRenderer.invoke('git:commitAndMerge', { taskId, worktreeCwd, projectCwd, targetBranch, commitMessage })
  },

  // Chat mode (structured agent sessions)
  chat: {
    send: (taskId: string, input: { text: string; images?: { mediaType: string; data: string }[] }) =>
      ipcRenderer.invoke('chat:send', { taskId, input }),
    interrupt: (taskId: string) => ipcRenderer.invoke('chat:interrupt', taskId),
    fork: (taskId: string, turnId: string) => ipcRenderer.invoke('chat:fork', { taskId, turnId }),
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
    respondPermission: (taskId: string, requestId: string, optionId: string) =>
      ipcRenderer.invoke('chat:permission', { taskId, requestId, optionId }),
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

