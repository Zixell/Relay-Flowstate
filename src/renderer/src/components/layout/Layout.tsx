import React from 'react'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { useAppStore, selectSelectedTask } from '../../stores/appStore'
import { Dashboard } from '../dashboard/Dashboard'
import { TaskDetail } from '../task/TaskDetail'
import { CreateTaskModal } from '../modals/CreateTaskModal'
import { SettingsModal } from '../modals/SettingsModal'
import { ImportSessionsModal } from '../modals/ImportSessionsModal'
import { SignInHost } from '../modals/SignInDialog'
import { GlobalPipelineDialog } from '../pipeline/PipelinePanels'
import { PipelineNotices } from '../pipeline/PipelineNotices'

export function Layout() {
  const selectedTask = useAppStore(selectSelectedTask)
  const isCreateModalOpen = useAppStore((s) => s.isCreateModalOpen)
  const closeCreateModal = useAppStore((s) => s.closeCreateModal)
  const isSettingsOpen = useAppStore((s) => s.isSettingsOpen)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const isImportOpen = useAppStore((s) => s.isImportOpen)
  const closeImport = useAppStore((s) => s.closeImport)
  const isGlobalPipelineOpen = useAppStore((s) => s.isGlobalPipelineOpen)
  const closeGlobalPipeline = useAppStore((s) => s.closeGlobalPipeline)

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a0a] text-zinc-100 select-none">
      <Sidebar />

      <div className="flex flex-col flex-1 min-w-0">
        <TopBar />

        <main className="flex-1 overflow-hidden">
          {selectedTask ? <TaskDetail task={selectedTask} /> : <Dashboard />}
        </main>
      </div>

      <CreateTaskModal open={isCreateModalOpen} onClose={closeCreateModal} />
      <SettingsModal open={isSettingsOpen} onClose={closeSettings} />
      <ImportSessionsModal open={isImportOpen} onClose={closeImport} />
      <SignInHost />
      {isGlobalPipelineOpen && <GlobalPipelineDialog onClose={closeGlobalPipeline} />}
      <PipelineNotices />
    </div>
  )
}
