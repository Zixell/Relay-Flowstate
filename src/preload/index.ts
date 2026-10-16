import { contextBridge, ipcRenderer } from 'electron'

const api = {
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
    create: (data: {
      projectId: string
      title: string
      prompt: string
      processType: string
      branch?: string
      cwd?: string
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
    getLogs: (taskId: string) => ipcRenderer.invoke('tasks:getLogs', taskId),
    getSummaries: (taskId: string) => ipcRenderer.invoke('tasks:getSummaries', taskId),
    onEvent: (taskId: string, callback: (event: unknown) => void) => {
      const listener = (_: Electron.IpcRendererEvent, event: unknown) => callback(event)
      ipcRenderer.on(`tasks:event:${taskId}`, listener)
      return () => ipcRenderer.removeListener(`tasks:event:${taskId}`, listener)
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

  // PTY
  pty: {
    write: (taskId: string, data: string) => ipcRenderer.invoke('pty:write', { taskId, data }),
    resize: (taskId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('pty:resize', { taskId, cols, rows }),
    kill: (taskId: string) => ipcRenderer.invoke('pty:kill', taskId),
    restart: (taskId: string, cols?: number, rows?: number) =>
      ipcRenderer.invoke('pty:restart', { taskId, cols, rows }),
    sessions: () => ipcRenderer.invoke('pty:sessions'),
    onData: (taskId: string, callback: (data: string) => void) => {
      const listener = (_: Electron.IpcRendererEvent, data: string) => callback(data)
      ipcRenderer.on(`pty:data:${taskId}`, listener)
      return () => ipcRenderer.removeListener(`pty:data:${taskId}`, listener)
    },
    onExit: (taskId: string, callback: (exitCode: number) => void) => {
      const listener = (_: Electron.IpcRendererEvent, exitCode: number) => callback(exitCode)
      ipcRenderer.on(`pty:exit:${taskId}`, listener)
      return () => ipcRenderer.removeListener(`pty:exit:${taskId}`, listener)
    },
    onAgentExit: (taskId: string, callback: (status: string) => void) => {
      const listener = (_: Electron.IpcRendererEvent, status: string) => callback(status)
      ipcRenderer.on(`pty:agent-exit:${taskId}`, listener)
      return () => ipcRenderer.removeListener(`pty:agent-exit:${taskId}`, listener)
    },
    onStatusChange: (taskId: string, callback: (status: string) => void) => {
      const listener = (_: Electron.IpcRendererEvent, status: string) => callback(status)
      ipcRenderer.on(`pty:status:${taskId}`, listener)
      return () => ipcRenderer.removeListener(`pty:status:${taskId}`, listener)
    },
    onSummary: (taskId: string, callback: (summary: string) => void) => {
      const listener = (_: Electron.IpcRendererEvent, summary: string) => callback(summary)
      ipcRenderer.on(`pty:summary:${taskId}`, listener)
      return () => ipcRenderer.removeListener(`pty:summary:${taskId}`, listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type RelayAPI = typeof api

