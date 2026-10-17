import React, { useCallback, useEffect, useState } from 'react'
import {
  MessageSquare,
  Bot,
  FileCode,
  GitCommit,
  GitMerge,
  Zap,
  AlertCircle,
  CheckCircle2
} from 'lucide-react'
import { cn, formatTimestamp } from '../../lib/utils'
import type { TaskEvent, TurnInfo } from '../../types'
import { MOCK_EVENTS } from '../../lib/mockData'
import { TurnChanges } from '../chat/TurnChanges'

const isElectron = typeof window !== 'undefined' && !!window.api

interface TaskTimelineProps {
  taskId: string
}

export function TaskTimeline({ taskId }: TaskTimelineProps) {
  const [events, setEvents] = useState<TaskEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [turns, setTurns] = useState<Map<string, TurnInfo>>(new Map())

  // Chat turns carry snapshot diffs; load them so turn events can show what changed.
  const loadTurns = useCallback(() => {
    if (!isElectron || !window.api.turns) return
    window.api.turns.list(taskId).then((list: TurnInfo[]) => setTurns(new Map(list.map((t) => [t.id, t]))))
  }, [taskId])

  useEffect(loadTurns, [loadTurns])

  useEffect(() => {
    if (!isElectron) {
      setEvents(MOCK_EVENTS.filter((e) => e.task_id === taskId))
      setLoading(false)
      return
    }
    setLoading(true)
    window.api.tasks.getEvents(taskId).then((data: TaskEvent[]) => {
      setEvents(data)
      setLoading(false)
    })

    const unsub = window.api.tasks.onEvent(taskId, (event: unknown) => {
      setEvents((prev) => [...prev, event as TaskEvent])
      if ((event as TaskEvent).type === 'turn_completed') loadTurns()
    })
    return unsub
  }, [taskId, loadTurns])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-24 text-xs text-zinc-600">
        Loading...
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 text-xs text-zinc-600">
        No events yet
      </div>
    )
  }

  return (
    <div className="space-y-1 py-2">
      {events.map((event, i) => (
        <TimelineEvent key={event.id} event={event} isLast={i === events.length - 1} taskId={taskId} turns={turns} />
      ))}
    </div>
  )
}

function TimelineEvent({
  event,
  isLast,
  taskId,
  turns
}: {
  event: TaskEvent
  isLast: boolean
  taskId: string
  turns: Map<string, TurnInfo>
}) {
  // Unknown types (e.g. written by a newer build) render as system events, never crash.
  const config = EVENT_CONFIG[event.type] ?? EVENT_CONFIG.system

  return (
    <div className="flex gap-3 group">
      {/* Line + icon */}
      <div className="flex flex-col items-center">
        <div
          className={cn(
            'w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5',
            config.iconBg
          )}
        >
          {config.icon}
        </div>
        {!isLast && <div className="w-px flex-1 bg-white/[0.05] mt-1 mb-1 min-h-[8px]" />}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-3">
        <div className="flex items-center gap-2 mb-1">
          <span className={cn('text-[11px] font-semibold', config.labelColor)}>{config.label}</span>
          <span className="text-[10px] text-zinc-600 font-mono">{formatTimestamp(event.timestamp)}</span>
        </div>

        {event.type === 'file_change' && event.content ? (
          <FileChangeList content={event.content} />
        ) : event.type === 'git_merge' && event.content ? (
          <MergeEventContent content={event.content} />
        ) : event.type === 'turn_completed' ? (
          <TurnEventContent event={event} taskId={taskId} turns={turns} />
        ) : event.content ? (
          <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">
            {event.content}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** A finished chat turn: how it ended and which files it touched. */
function TurnEventContent({ event, taskId, turns }: { event: TaskEvent; taskId: string; turns: Map<string, TurnInfo> }) {
  let meta: { turnId?: string; reason?: string; files?: string[] } = {}
  try {
    meta = event.metadata ? JSON.parse(event.metadata) : {}
  } catch {
    // keep defaults
  }
  const files = meta.files ?? []
  const ended = meta.reason === 'interrupted' ? 'Interrupted' : meta.reason === 'error' ? 'Ended with an error' : null
  const turn = meta.turnId ? turns.get(meta.turnId) : undefined
  if (turn?.files.length) {
    return (
      <div className="space-y-1.5">
        {ended && <p className="text-xs text-zinc-500">{ended}</p>}
        <TurnChanges taskId={taskId} turn={turn} autoOpen={false} />
      </div>
    )
  }
  return (
    <div className="space-y-1">
      {ended && <p className="text-xs text-zinc-500">{ended}</p>}
      {files.length === 0 ? (
        <p className="text-xs text-zinc-500">No file changes</p>
      ) : (
        files.map((f) => (
          <div key={f} className="text-[11px] font-mono text-zinc-300 truncate">
            {f}
          </div>
        ))
      )}
    </div>
  )
}

function MergeEventContent({ content }: { content: string }) {
  try {
    const { targetBranch, commit } = JSON.parse(content) as { targetBranch: string; commit: string }
    return (
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-xs text-zinc-400">into</span>
        <span className="text-xs font-mono text-emerald-400">{targetBranch}</span>
        <span className="text-[10px] font-mono text-zinc-600 bg-white/[0.04] px-1.5 py-0.5 rounded">
          {commit.slice(0, 7)}
        </span>
      </div>
    )
  } catch {
    return <p className="text-xs text-zinc-500">{content}</p>
  }
}

function FileChangeList({ content }: { content: string }) {
  try {
    const files = JSON.parse(content) as Array<{
      path: string
      type: string
      additions?: number
      deletions?: number
    }>
    return (
      <div className="space-y-1 mt-1">
        {files.map((f) => (
          <div key={f.path} className="flex items-center gap-2 text-[11px] font-mono">
            <span
              className={cn(
                'px-1.5 py-0.5 rounded text-[9px] font-bold uppercase',
                f.type === 'added'
                  ? 'bg-emerald-400/10 text-emerald-400'
                  : f.type === 'deleted'
                    ? 'bg-red-400/10 text-red-400'
                    : 'bg-blue-400/10 text-blue-400'
              )}
            >
              {f.type === 'added' ? '+' : f.type === 'deleted' ? '−' : '~'}
            </span>
            <span className="text-zinc-300 truncate">{f.path}</span>
            {f.additions !== undefined && (
              <span className="text-emerald-500 ml-auto shrink-0">+{f.additions}</span>
            )}
            {f.deletions !== undefined && f.deletions > 0 && (
              <span className="text-red-500">-{f.deletions}</span>
            )}
          </div>
        ))}
      </div>
    )
  } catch {
    return <p className="text-xs text-zinc-500">{content}</p>
  }
}

const EVENT_CONFIG: Record<
  TaskEvent['type'],
  { icon: React.ReactNode; iconBg: string; label: string; labelColor: string }
> = {
  user_prompt: {
    icon: <MessageSquare className="w-3 h-3 text-white" />,
    iconBg: 'bg-zinc-700',
    label: 'Prompt',
    labelColor: 'text-zinc-300'
  },
  ai_response: {
    icon: <Bot className="w-3 h-3 text-orange-400" />,
    iconBg: 'bg-orange-400/10',
    label: 'Agent',
    labelColor: 'text-orange-400'
  },
  file_change: {
    icon: <FileCode className="w-3 h-3 text-blue-400" />,
    iconBg: 'bg-blue-400/10',
    label: 'File Changes',
    labelColor: 'text-blue-400'
  },
  git_snapshot: {
    icon: <GitCommit className="w-3 h-3 text-violet-400" />,
    iconBg: 'bg-violet-400/10',
    label: 'Git Snapshot',
    labelColor: 'text-violet-400'
  },
  system: {
    icon: <Zap className="w-3 h-3 text-zinc-400" />,
    iconBg: 'bg-zinc-800',
    label: 'System',
    labelColor: 'text-zinc-500'
  },
  error: {
    icon: <AlertCircle className="w-3 h-3 text-red-400" />,
    iconBg: 'bg-red-400/10',
    label: 'Error',
    labelColor: 'text-red-400'
  },
  turn_completed: {
    icon: <CheckCircle2 className="w-3 h-3 text-blue-400" />,
    iconBg: 'bg-blue-400/10',
    label: 'Turn',
    labelColor: 'text-blue-400'
  },
  git_merge: {
    icon: <GitMerge className="w-3 h-3 text-emerald-400" />,
    iconBg: 'bg-emerald-400/10',
    label: 'Merged',
    labelColor: 'text-emerald-400'
  }
}
