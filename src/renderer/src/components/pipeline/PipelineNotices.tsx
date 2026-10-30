import React, { useEffect, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'

interface Notice {
  id: number
  taskId: string
  title: string
  message: string
}

/** Notify blocks that fired while the app was in front; the system would not show them. */
export function PipelineNotices() {
  const selectTask = useAppStore((s) => s.selectTask)
  const [notices, setNotices] = useState<Notice[]>([])

  useEffect(() => {
    if (!window.api?.pipelines) return
    let next = 0
    return window.api.pipelines.onNotify((n) => {
      const notice = { ...n, id: next++ }
      setNotices((list) => [...list, notice])
      setTimeout(() => setNotices((list) => list.filter((x) => x.id !== notice.id)), 8000)
    })
  }, [])

  if (!notices.length) return null
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 w-80">
      {notices.map((n) => (
        <div key={n.id} className="flex items-start gap-2.5 rounded-xl border border-violet-500/25 bg-[#141414]/95 backdrop-blur px-3.5 py-3 shadow-2xl">
          <Bell className="w-3.5 h-3.5 mt-0.5 text-violet-300 shrink-0" />
          <button onClick={() => selectTask(n.taskId)} className="flex-1 min-w-0 text-left">
            <p className="text-[12px] font-medium text-zinc-100 truncate">{n.title}</p>
            <p className="text-[12px] text-zinc-400 break-words">{n.message}</p>
          </button>
          <button onClick={() => setNotices((list) => list.filter((x) => x.id !== n.id))} className="p-0.5 rounded text-zinc-500 hover:text-zinc-200">
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
