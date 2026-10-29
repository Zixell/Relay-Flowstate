import React, { useEffect } from 'react'
import { AppWindow, X, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { STATUS_CONFIG } from '../../types'
import { useAppStore } from '../../stores/appStore'
import { useTaskSync } from '../../hooks/useTaskSync'
import { ChatView } from '../chat/ChatView'
import { SignInHost } from '../modals/SignInDialog'

const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

/** A floating chat window: one task's chat above every other app. */
export function PipApp({ taskId }: { taskId: string }) {
  useTaskSync()
  const task = useAppStore((s) => s.tasks.find((t) => t.id === taskId))
  const loaded = useAppStore((s) => s.tasks.length > 0)

  useEffect(() => {
    document.title = task ? task.title : 'Relay Flowstate'
  }, [task?.title]) // eslint-disable-line react-hooks/exhaustive-deps

  // The task was deleted in the main window
  useEffect(() => {
    if (loaded && !task) window.api.window.close()
  }, [loaded, task])

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0a0a0a] text-zinc-100 select-none">
      <header
        className="flex items-center gap-2 h-9 pl-3 pr-1 border-b border-white/[0.06] bg-[#0d0d0d] shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {task && <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', STATUS_CONFIG[task.status].dot)} />}
        <span className="text-[12px] font-medium text-zinc-200 truncate">{task?.title ?? 'Loading…'}</span>
        <div className="ml-auto flex items-center" style={noDrag}>
          <button
            onClick={() => void window.api.pip.showInMain(taskId)}
            title="Open in the app"
            className="h-7 w-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06]"
          >
            <AppWindow className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => window.api.window.close()}
            title="Close"
            className="h-7 w-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0">
        {task ? (
          <ChatView task={task} compact />
        ) : (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
          </div>
        )}
      </div>
      <SignInHost />
    </div>
  )
}
