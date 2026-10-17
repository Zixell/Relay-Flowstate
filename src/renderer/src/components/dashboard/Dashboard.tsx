import React from 'react'
import { useAppStore, selectFilteredTasks } from '../../stores/appStore'
import { TaskCard } from './TaskCard'
import { EmptyState } from './EmptyState'
import { Loader2 } from 'lucide-react'
import type { TaskStatus } from '../../types'

const SECTION_ORDER: TaskStatus[] = ['running', 'waiting', 'failed', 'paused', 'completed']
const SECTION_LABELS: Record<TaskStatus, string> = {
  running: 'Active',
  waiting: 'Waiting for Input',
  failed: 'Failed',
  paused: 'Paused',
  completed: 'Completed',
  pending: 'Pending'
}

export function Dashboard() {
  const isLoading = useAppStore((s) => s.isLoading)
  const tasks = useAppStore(selectFilteredTasks)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-zinc-600 animate-spin" />
      </div>
    )
  }

  if (tasks.length === 0) {
    return <EmptyState />
  }

  // Group tasks by status, ordered
  const grouped: Partial<Record<TaskStatus, typeof tasks>> = {}
  for (const task of tasks) {
    if (!grouped[task.status]) grouped[task.status] = []
    grouped[task.status]!.push(task)
  }

  const sections = SECTION_ORDER.filter((s) => grouped[s] && grouped[s]!.length > 0)

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-8 animate-fade-in">
        {/* Summary bar */}
        <SummaryBar tasks={tasks} />

        {sections.map((status) => (
          <section key={status}>
            <div className="flex items-center gap-2 mb-3">
              <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">
                {SECTION_LABELS[status]}
              </h2>
              <span className="text-xs text-zinc-700">{grouped[status]!.length}</span>
              <div className="flex-1 h-px bg-white/[0.04] ml-1" />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {grouped[status]!.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function SummaryBar({ tasks }: { tasks: ReturnType<typeof selectFilteredTasks> }) {
  const counts = {
    running: tasks.filter((t) => t.status === 'running').length,
    waiting: tasks.filter((t) => t.status === 'waiting').length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    failed: tasks.filter((t) => t.status === 'failed').length
  }

  return (
    <div className="grid grid-cols-4 gap-3">
      <StatCard label="Running" value={counts.running} color="text-emerald-400" dot="bg-emerald-400" pulse />
      <StatCard label="Waiting" value={counts.waiting} color="text-amber-400" dot="bg-amber-400" />
      <StatCard label="Completed" value={counts.completed} color="text-blue-400" dot="bg-blue-400" />
      <StatCard label="Failed" value={counts.failed} color="text-red-400" dot="bg-red-400" />
    </div>
  )
}

function StatCard({
  label,
  value,
  color,
  dot,
  pulse
}: {
  label: string
  value: number
  color: string
  dot: string
  pulse?: boolean
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-1.5 h-1.5 rounded-full ${dot} ${pulse ? 'animate-pulse' : ''}`} />
        <span className="text-[11px] font-medium text-zinc-500">{label}</span>
      </div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  )
}
