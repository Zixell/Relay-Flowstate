import React from 'react'
import { Terminal, Zap, ArrowRight } from 'lucide-react'
import { Button } from '../ui/button'
import { useAppStore } from '../../stores/appStore'

export function EmptyState() {
  const openCreateModal = useAppStore((s) => s.openCreateModal)

  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8 animate-fade-in">
      <div className="relative mb-8">
        <div className="w-20 h-20 rounded-2xl bg-white/[0.03] border border-white/[0.07] flex items-center justify-center mb-4">
          <Terminal className="w-9 h-9 text-zinc-600" />
        </div>
        <div className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center">
          <Zap className="w-3 h-3 text-white" />
        </div>
      </div>

      <h2 className="text-xl font-semibold text-zinc-200 mb-2 tracking-tight">
        No tasks yet
      </h2>
      <p className="text-sm text-zinc-500 max-w-sm leading-relaxed mb-8">
        Relay Flowstate turns AI coding sessions into persistent, resumable workspaces.
        Start a task to begin working with Claude Code, Codex, or any CLI agent.
      </p>

      <Button variant="primary" onClick={openCreateModal} className="gap-2 mb-10">
        <Zap className="w-4 h-4" />
        Create your first task
        <ArrowRight className="w-4 h-4" />
      </Button>

      <div className="grid grid-cols-3 gap-4 max-w-lg w-full">
        {[
          {
            icon: '⚡',
            title: 'Persistent sessions',
            desc: 'Tasks never disappear. Resume any session anytime.'
          },
          {
            icon: '🔀',
            title: 'Multi-agent',
            desc: 'Claude Code, Codex — all in one place.'
          },
          {
            icon: '📁',
            title: 'Project-linked',
            desc: 'Each task ties to a local repo with full context.'
          }
        ].map((item) => (
          <div
            key={item.title}
            className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-left"
          >
            <div className="text-xl mb-2">{item.icon}</div>
            <div className="text-xs font-semibold text-zinc-300 mb-1">{item.title}</div>
            <div className="text-xs text-zinc-600 leading-relaxed">{item.desc}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
