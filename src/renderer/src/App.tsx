import React, { useEffect } from 'react'
import { Layout } from './components/layout/Layout'
import { useAppStore } from './stores/appStore'
import { useTaskSync } from './hooks/useTaskSync'

export default function App() {
  useTaskSync()

  // A clicked system notification, or a floating chat's "open in app", opens its task.
  useEffect(() => {
    if (!window.api?.chat?.onSelectTask) return
    return window.api.chat.onSelectTask((taskId) => useAppStore.getState().selectTask(taskId))
  }, [])

  return <Layout />
}
