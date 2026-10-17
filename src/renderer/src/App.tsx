import React, { useEffect } from 'react'
import { Layout } from './components/layout/Layout'
import { useAppStore } from './stores/appStore'
import type { Task } from './types'

export default function App() {
  const loadData = useAppStore((s) => s.loadData)
  const refreshTasks = useAppStore((s) => s.refreshTasks)
  const updateTask = useAppStore((s) => s.updateTask)

  useEffect(() => {
    loadData()

    // Refresh task list every 10s to pick up status changes
    const interval = setInterval(refreshTasks, 10_000)
    return () => clearInterval(interval)
  }, [loadData, refreshTasks])

  // Chat-mode tasks report status changes centrally, not through a mounted terminal.
  useEffect(() => {
    if (!window.api?.chat) return
    return window.api.chat.onTaskStatus(({ taskId, status, changedFilesCount }) => {
      updateTask(taskId, {
        status: status as Task['status'],
        updated_at: Math.floor(Date.now() / 1000),
        ...(changedFilesCount != null && { changed_files_count: changedFilesCount })
      })
      // The dashboard card shows the latest reply and any pending approval.
      void window.api.tasks.getById(taskId).then((row: Task | null) => {
        if (row) updateTask(taskId, { last_message: row.last_message, pending_permission: row.pending_permission })
      })
    })
  }, [updateTask])

  return <Layout />
}
