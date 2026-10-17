import React, { useState, useCallback, useMemo } from 'react'
import {
  GitBranch,
  Clock,
  FileCode,
  Play,
  ChevronRight,
  Loader2,
  AlertCircle,
  CheckCircle2,
  PauseCircle,
  MessageSquare,
  Folder,
  Trash2,
  ShieldAlert
} from 'lucide-react'
import { cn, formatDuration, formatRelativeTime } from '../../lib/utils'
import { STATUS_CONFIG, processLabel, processColor, type Task } from '../../types'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { useAppStore } from '../../stores/appStore'
import { ContextMenu, type ContextMenuState } from '../ui/context-menu'

const isElectron = typeof window !== 'undefined' && !!window.api

interface TaskCardProps {
  task: Task
}

export function TaskCard({ task }: TaskCardProps) {
  const selectTask = useAppStore((s) => s.selectTask)
  const deleteTask = useAppStore((s) => s.deleteTask)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const statusCfg = STATUS_CONFIG[task.status]
  const agents = useAppStore((s) => s.agents)
  const agentColor = processColor(task.process_type, agents)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const handleDeleteTask = useCallback(async () => {
    if (isElectron) await window.api.tasks.delete(task.id)
    deleteTask(task.id)
  }, [task.id, deleteTask])

  const approval = useMemo(() => {
    if (!task.pending_permission) return null
    try {
      return (JSON.parse(task.pending_permission) as { title?: string }).title ?? 'Permission request'
    } catch {
      return 'Permission request'
    }
  }, [task.pending_permission])
  const lastMessage = plainPreview(task.last_message)

  return (
    <>
    <div
      className={cn(
        'group relative rounded-xl border bg-[#111] transition-all duration-200 cursor-pointer overflow-hidden',
        'hover:border-white/[0.12] hover:bg-[#131313] hover:shadow-lg hover:shadow-black/30',
        task.status === 'running'
          ? 'border-white/[0.09]'
          : task.status === 'failed'
            ? 'border-red-500/10'
            : task.status === 'waiting'
              ? 'border-amber-500/10'
              : 'border-white/[0.06]'
      )}
      onClick={() => selectTask(task.id)}
      onContextMenu={handleContextMenu}
    >
      {/* Running accent bar */}
      {task.status === 'running' && (
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-emerald-500/60 via-emerald-400 to-emerald-500/60" />
      )}
      {task.status === 'waiting' && (
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-amber-500/60" />
      )}
      {task.status === 'failed' && (
        <div className="absolute top-0 left-0 right-0 h-[2px] bg-red-500/40" />
      )}

      <div className="p-4">
        {/* Header row */}
        <div className="flex items-start gap-3 mb-3">
          {/* Status icon */}
          <div className="mt-0.5 shrink-0">
            <StatusIcon status={task.status} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-3">
              <h3 className="text-sm font-semibold text-zinc-100 leading-snug line-clamp-2 group-hover:text-white transition-colors">
                {task.title}
              </h3>
              <ChevronRight className="w-4 h-4 text-zinc-600 mt-0.5 shrink-0 group-hover:text-zinc-400 transition-colors" />
            </div>

            {/* Meta row */}
            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              {/* Project */}
              <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                <Folder className="w-3 h-3" />
                <span>{task.project_name}</span>
              </div>

              {/* Process type */}
              <div className="flex items-center gap-1 text-[11px]" style={{ color: agentColor }}>
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: agentColor }}
                />
                <span>{processLabel(task.process_type, agents)}</span>
              </div>

              {/* Branch */}
              {task.branch && (
                <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                  <GitBranch className="w-3 h-3" />
                  <span className="font-mono truncate max-w-[120px]">{task.branch}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex items-center gap-4 mb-3">
          <StatChip
            icon={<Clock className="w-3 h-3" />}
            value={formatDuration(task.runtime_seconds)}
          />
          {task.changed_files_count > 0 && (
            <StatChip
              icon={<FileCode className="w-3 h-3" />}
              value={`${task.changed_files_count} files`}
            />
          )}
          <StatChip
            icon={<Clock className="w-3 h-3" />}
            value={formatRelativeTime(task.updated_at)}
            className="ml-auto"
          />
          <Badge variant={task.status} className="text-[10px] px-1.5 py-0.5">
            <span
              className={cn(
                'w-1.5 h-1.5 rounded-full',
                task.status === 'running' && 'animate-pulse',
                statusCfg.dot
              )}
            />
            {statusCfg.label}
          </Badge>
        </div>

        {approval && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-3 py-1.5 mb-3 text-[11px]">
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-amber-300 shrink-0">Needs approval</span>
            <span className="text-amber-200/60 font-mono truncate">{approval}</span>
          </div>
        )}

        {/* Agent's latest reply */}
        {lastMessage && !approval && (
          <p className="text-[11.5px] text-zinc-400 leading-relaxed line-clamp-2 mb-3">{lastMessage}</p>
        )}

        {/* Action row */}
        <div className="flex items-center gap-2">
          {(task.status === 'paused' || task.status === 'completed' || task.status === 'failed') && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-[11px] gap-1"
              onClick={(e) => {
                e.stopPropagation()
                selectTask(task.id)
              }}
            >
              <Play className="w-3 h-3" />
              Resume
            </Button>
          )}
          {task.status === 'waiting' && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-[11px] gap-1 border-amber-500/20 text-amber-400 hover:bg-amber-500/10"
              onClick={(e) => {
                e.stopPropagation()
                selectTask(task.id)
              }}
            >
              {approval ? <ShieldAlert className="w-3 h-3" /> : <MessageSquare className="w-3 h-3" />}
              {approval ? 'Review' : 'Respond'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[11px] gap-1 ml-auto"
            onClick={(e) => {
              e.stopPropagation()
              selectTask(task.id)
            }}
          >
            Open
            <ChevronRight className="w-3 h-3" />
          </Button>
        </div>
      </div>
    </div>
    {ctxMenu && (
      <ContextMenu
        x={ctxMenu.x}
        y={ctxMenu.y}
        onClose={() => setCtxMenu(null)}
        items={[
          {
            label: 'Delete Task',
            icon: <Trash2 className="w-3.5 h-3.5" />,
            variant: 'danger',
            onClick: handleDeleteTask
          }
        ]}
      />
    )}
    </>
  )
}

/** First lines of a markdown reply as plain text. */
function plainPreview(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

function StatusIcon({ status }: { status: Task['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="w-4 h-4 text-emerald-400 animate-spin" />
    case 'waiting':
      return <MessageSquare className="w-4 h-4 text-amber-400" />
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-blue-400" />
    case 'failed':
      return <AlertCircle className="w-4 h-4 text-red-400" />
    case 'paused':
      return <PauseCircle className="w-4 h-4 text-zinc-500" />
    default:
      return <Clock className="w-4 h-4 text-zinc-600" />
  }
}

function StatChip({
  icon,
  value,
  className
}: {
  icon: React.ReactNode
  value: string
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-1 text-[11px] text-zinc-500', className)}>
      {icon}
      <span>{value}</span>
    </div>
  )
}
