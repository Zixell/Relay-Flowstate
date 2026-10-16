import React, { useState, useEffect, useRef } from 'react'
import { Plus, Search, GitBranch, ArrowUp, Check, CheckCircle, XCircle } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import type { TaskStatus } from '../../types'
import { GitCommitModal } from '../modals/GitCommitModal'

const STATUS_FILTERS: { label: string; value: TaskStatus | null }[] = [
  { label: 'All', value: null },
  { label: 'Running', value: 'running' },
  { label: 'Waiting', value: 'waiting' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' }
]

const isElectron = typeof window !== 'undefined' && !!window.api

// ── Git Branch Widget ────────────────────────────────────────────────────────

function GitBranchWidget({ cwd, worktreePath, targetBranch }: { cwd: string | null; worktreePath?: string | null; targetBranch?: string | null }) {
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const [toast, setToast] = useState<{ message: string; ok: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  // Fetch git branch from the worktree specifically — the project directory may be
  // checked out to a different branch (e.g. after a merge) and must not affect the display.
  useEffect(() => {
    const fetchPath = worktreePath || cwd
    if (!fetchPath || !isElectron) { setGitBranch(null); return }
    window.api.git.getWorkingStatus(fetchPath)
      .then((s: { isGitRepo: boolean; branch: string }) => setGitBranch(s.isGitRepo ? s.branch : null))
      .catch(() => setGitBranch(null))
  }, [worktreePath, cwd])

  // When task has a worktree: show its actual git branch (stable, unaffected by merge).
  // When no worktree: show targetBranch set at task creation (fixes "always shows main" bug).
  const branch = worktreePath ? gitBranch : (targetBranch || gitBranch)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [menuOpen])

  const showToast = (message: string, ok: boolean) => {
    setToast({ message, ok })
    setTimeout(() => setToast(null), 6000)
  }

  const handlePush = async () => {
    if (!cwd || !isElectron || busy) return
    setMenuOpen(false)
    setBusy(true)
    try {
      // Push to targetBranch on origin so the task's changes are published under
      // the merge-target branch name rather than the internal relay/task-XXXXXXXX branch.
      const result = await window.api.git.push(cwd, targetBranch || undefined)
      const reason = [result.stderr, result.stdout].filter(Boolean).join('\n').trim()
      showToast(
        result.success ? `Pushed to origin/${targetBranch || 'HEAD'}` : (reason || 'Push failed'),
        result.success
      )
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Push failed', false)
    } finally {
      setBusy(false)
    }
  }

  const handleCommitted = () => {
    setCommitOpen(false)
    showToast('Committed successfully', true)
    if (cwd && isElectron) {
      window.api.git.getWorkingStatus(cwd)
        .then((s: { isGitRepo: boolean; branch: string }) => setGitBranch(s.isGitRepo ? s.branch : null))
        .catch(() => {})
    }
  }

  if (!branch) return null

  return (
    <>
      {/* Toast — fixed bottom-right */}
      {toast && (
        <div
          className={cn(
            'fixed bottom-5 right-5 z-[100] max-w-sm flex items-start gap-2 px-3 py-2.5 rounded-lg border shadow-xl text-xs leading-snug',
            toast.ok
              ? 'bg-[#111] border-emerald-500/30 text-emerald-300'
              : 'bg-[#111] border-red-500/30 text-red-300'
          )}
        >
          {toast.ok
            ? <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
            : <XCircle className="w-3.5 h-3.5 shrink-0 mt-px" />}
          <span className="whitespace-pre-wrap break-words">{toast.message}</span>
        </div>
      )}

      <div className="relative">
        <button
          ref={btnRef}
          onClick={() => setMenuOpen((o) => !o)}
          disabled={busy}
          className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/[0.06] bg-white/[0.02] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05] hover:border-white/10 text-xs transition-all duration-100 disabled:opacity-50 font-mono"
        >
          <GitBranch className="w-3.5 h-3.5 shrink-0 text-zinc-500" />
          <span>{branch}</span>
          {busy && <span className="w-2.5 h-2.5 border border-zinc-500 border-t-zinc-300 rounded-full animate-spin shrink-0" />}
        </button>

        {menuOpen && (
          <div
            ref={menuRef}
            className="absolute top-full right-0 mt-1.5 min-w-[140px] rounded-lg border border-white/[0.08] bg-[#1a1a1a] shadow-xl py-1 z-50"
          >
            <button
              className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-zinc-300 hover:bg-white/[0.06] transition-colors"
              onClick={() => { setMenuOpen(false); setCommitOpen(true) }}
            >
              <Check className="w-3.5 h-3.5 text-zinc-400" />
              Commit
            </button>
            <button
              className="flex items-center gap-2.5 w-full px-3 py-2 text-xs text-zinc-300 hover:bg-white/[0.06] transition-colors"
              onClick={handlePush}
            >
              <ArrowUp className="w-3.5 h-3.5 text-zinc-400" />
              <span>Push{targetBranch ? ` ${targetBranch}` : ''}</span>
            </button>
          </div>
        )}

        {commitOpen && cwd && (
          <GitCommitModal
            open={commitOpen}
            cwd={cwd}
            onClose={() => setCommitOpen(false)}
            onCommitted={handleCommitted}
          />
        )}
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export function TopBar() {
  const { statusFilter, setStatusFilter, openCreateModal, selectedTaskId, selectTask } = useAppStore()

  const activePath = useAppStore((s) => {
    const task = s.selectedTaskId ? s.tasks.find((t) => t.id === s.selectedTaskId) : null
    if (task) return task.worktree_path || task.project_path
    if (s.selectedProjectId) return s.projects.find((p) => p.id === s.selectedProjectId)?.path ?? null
    return null
  })

  const selectedTaskBranch = useAppStore((s) => {
    const task = s.selectedTaskId ? s.tasks.find((t) => t.id === s.selectedTaskId) : null
    return task?.branch ?? null
  })

  const selectedTaskWorktreePath = useAppStore((s) => {
    const task = s.selectedTaskId ? s.tasks.find((t) => t.id === s.selectedTaskId) : null
    return task?.worktree_path ?? null
  })

  return (
    <header className="flex items-center h-12 px-4 border-b border-white/[0.06] bg-[#0d0d0d] shrink-0 gap-3">
      {/* Custom window controls — macOS shows its native traffic lights instead */}
      {isElectron && window.api.platform !== 'darwin' && (
        <div className="flex items-center gap-1.5 mr-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={() => window.api.window.close()}
            className="w-3 h-3 rounded-full bg-zinc-700 hover:bg-red-500 transition-colors"
          />
          <button
            onClick={() => window.api.window.minimize()}
            className="w-3 h-3 rounded-full bg-zinc-700 hover:bg-amber-500 transition-colors"
          />
          <button
            onClick={() => window.api.window.maximize()}
            className="w-3 h-3 rounded-full bg-zinc-700 hover:bg-emerald-500 transition-colors"
          />
        </div>
      )}

      {/* Breadcrumb */}
      {selectedTaskId && (
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <button
            onClick={() => selectTask(null)}
            className="hover:text-zinc-300 transition-colors"
          >
            Tasks
          </button>
          <span>/</span>
          <span className="text-zinc-300 truncate max-w-[200px]">
            {useAppStore.getState().tasks.find((t) => t.id === selectedTaskId)?.title}
          </span>
        </div>
      )}

      {/* Status filters (only on dashboard) */}
      {!selectedTaskId && (
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.label}
              onClick={() => setStatusFilter(f.value)}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-100',
                statusFilter === f.value
                  ? 'bg-white/[0.08] text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        <GitBranchWidget cwd={activePath} worktreePath={selectedTaskWorktreePath} targetBranch={selectedTaskBranch} />

        <button className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-white/[0.06] bg-white/[0.02] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.05] hover:border-white/10 text-xs transition-all duration-100">
          <Search className="w-3.5 h-3.5" />
          <span>Search</span>
          <kbd className="ml-1 text-[10px] bg-white/[0.06] px-1.5 py-0.5 rounded text-zinc-600">
            ⌘K
          </kbd>
        </button>

        <Button variant="primary" size="sm" onClick={openCreateModal} className="gap-1.5 h-8 text-xs">
          <Plus className="w-3.5 h-3.5" />
          New Task
        </Button>
      </div>
    </header>
  )
}
