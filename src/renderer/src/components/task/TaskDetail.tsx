import React, { useState, useEffect, useCallback } from 'react'
import {
  ArrowLeft,
  GitBranch,
  Clock,
  FileCode,
  Square,
  Loader2,
  MessageSquare,
  Folder,
  Save,
  GitCommit,
  CheckCircle2,
  PauseCircle,
  GitMerge,
  Copy,
  Check,
  Sparkles
} from 'lucide-react'
import { cn, formatDuration, formatRelativeTime, truncatePath } from '../../lib/utils'
import { STATUS_CONFIG, type Task } from '../../types'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { SidecarConsole } from './SidecarConsole'
import { AgentPicker } from '../chat/AgentSwitch'
import { ChatView } from '../chat/ChatView'
import { WorktreeWarning } from './WorktreeWarning'
import { MergeModal } from '../modals/MergeModal'
import { TaskTimeline } from './TaskTimeline'
import { FileChanges } from './FileChanges'
import { useAppStore } from '../../stores/appStore'

const isElectron = typeof window !== 'undefined' && !!window.api

interface TaskDetailProps {
  task: Task
}

type DetailTab = 'chat' | 'console' | 'timeline' | 'files' | 'notes' | 'summary'

function worktreeOptedOut(task: Task): boolean {
  try {
    return task.metadata ? JSON.parse(task.metadata).worktree === false : false
  } catch {
    return false
  }
}

export function TaskDetail({ task }: TaskDetailProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>('chat')
  const [notes, setNotes] = useState(task.notes ?? '')
  const [notesSaved, setNotesSaved] = useState(false)
  const [summaries, setSummaries] = useState<SessionSummaryEntry[]>([])
  const [recapping, setRecapping] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [merged, setMerged] = useState(false)
  const selectTask = useAppStore((s) => s.selectTask)
  const updateTask = useAppStore((s) => s.updateTask)

  // Every task opens on its conversation.
  useEffect(() => {
    setActiveTab('chat')
  }, [task.id])

  // Sync notes when task changes
  useEffect(() => {
    setNotes(task.notes ?? '')
  }, [task.id, task.notes])

  // Load full summary history when task changes
  useEffect(() => {
    setSummaries([])
    setRecapping(false)
    if (!isElectron) return
    window.api.tasks.getSummaries(task.id).then((list: SessionSummaryEntry[]) => {
      if (list?.length) setSummaries(list)
    }).catch(() => {})
  }, [task.id])

  // Eagerly fetch file count so the Files tab label is correct on first render
  useEffect(() => {
    if (!isElectron || !task.project_path) return
    const startCommit: string | undefined = (() => {
      try { return task.metadata ? JSON.parse(task.metadata).startCommit : undefined } catch { return undefined }
    })()
    const gitCwd = task.worktree_path || task.project_path
    window.api.git.getChanges(gitCwd, undefined, startCommit).then((data) => {
      if (data.files.length !== task.changed_files_count) {
        updateTask(task.id, { changed_files_count: data.files.length })
      }
    }).catch(() => {})
  }, [task.id, task.project_path, task.worktree_path])

  // Live summary updates — receives the full array as JSON
  useEffect(() => {
    if (!isElectron || !window.api.tasks.onSummary) return
    const unsub = window.api.tasks.onSummary(task.id, (allSummariesJson) => {
      try {
        const list: SessionSummaryEntry[] = JSON.parse(allSummariesJson)
        if (Array.isArray(list)) setSummaries(list)
      } catch { /* ignore malformed */ }
      updateTask(task.id, { updated_at: Math.floor(Date.now() / 1000) })
    })
    return unsub
  }, [task.id, updateTask])

  const handleRecap = useCallback(async () => {
    if (!isElectron) return
    setRecapping(true)
    try {
      await window.api.tasks.recap(task.id)
    } catch (err) {
      console.warn('[relay] recap failed:', err)
    } finally {
      setRecapping(false)
    }
  }, [task.id])

  const handleMerged = useCallback(() => {
    setMerged(true)
    setTimeout(() => setMerged(false), 3000)
  }, [])

  const handleStop = useCallback(async () => {
    if (!isElectron) return
    setIsStopping(true)
    // The status follows from the agent's turn.completed (interrupted) event.
    await window.api.chat.interrupt(task.id)
    setIsStopping(false)
  }, [task.id])

  const handleSaveNotes = useCallback(async () => {
    if (isElectron) {
      await window.api.tasks.updateNotes({ id: task.id, notes })
    }
    updateTask(task.id, { notes })
    setNotesSaved(true)
    setTimeout(() => setNotesSaved(false), 1500)
  }, [task.id, notes, updateTask])


  const statusCfg = STATUS_CONFIG[task.status]

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Detail header */}
      <div className="flex items-start gap-4 px-6 py-4 border-b border-white/[0.06] bg-[#0d0d0d] shrink-0">
        <button
          onClick={() => selectTask(null)}
          className="mt-0.5 p-1.5 -ml-1 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition-all"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              {/* Title */}
              <h1 className="text-base font-semibold text-zinc-100 leading-snug mb-2">
                {task.title}
              </h1>

              {/* Meta chips */}
              <div className="flex items-center gap-3 flex-wrap">
                {/* Status */}
                <Badge variant={task.status} className="gap-1.5">
                  <StatusDot status={task.status} />
                  {statusCfg.label}
                </Badge>

                {/* Agent — click to continue the task with another one */}
                <AgentPicker task={task} disabled={task.status === 'running' || task.status === 'waiting'} />

                {/* Project */}
                <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                  <Folder className="w-3 h-3" />
                  <span>{task.project_name}</span>
                  <span className="text-zinc-700">·</span>
                  <span className="font-mono text-[10px]">{truncatePath(task.project_path, 35)}</span>
                </div>

                {/* Branch */}
                {task.branch && (
                  <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                    <GitBranch className="w-3 h-3" />
                    <span className="font-mono">{task.branch}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 shrink-0">
              {task.status === 'running' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-8 text-xs"
                  onClick={handleStop}
                  disabled={isStopping}
                >
                  <Square className="w-3 h-3" />
                  {isStopping ? 'Stopping...' : 'Stop'}
                </Button>
              )}
              {task.status === 'waiting' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-8 text-xs border-amber-500/20 text-amber-400 hover:bg-amber-500/10"
                  onClick={() => setActiveTab('chat')}
                >
                  <MessageSquare className="w-3 h-3" />
                  Respond to Agent
                </Button>
              )}
              {isElectron && task.worktree_path && (
                <button
                  onClick={() => setMergeOpen(true)}
                  className={cn(
                    'flex items-center gap-1.5 px-3 h-8 rounded-lg text-xs font-medium border transition-colors',
                    merged
                      ? 'border-emerald-500/30 text-emerald-400'
                      : 'border-blue-500/30 text-blue-400 hover:bg-blue-500/10 hover:border-blue-500/50'
                  )}
                >
                  {merged ? <CheckCircle2 className="w-3 h-3" /> : <GitMerge className="w-3 h-3" />}
                  <span>{merged ? 'Merged!' : 'Merge'}</span>
                </button>
              )}
            </div>
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-4 mt-3">
            <RuntimeDisplay task={task} />
            <StatItem icon={<FileCode className="w-3 h-3" />} label={`${task.changed_files_count} files changed`} />
            <StatItem
              icon={<Clock className="w-3 h-3" />}
              label={`Last activity ${formatRelativeTime(task.updated_at)}`}
            />
          </div>
        </div>
      </div>

      {/* Not isolated: the agent edits the user's own checkout. No warning when that was the user's choice. */}
      {!task.worktree_path && !worktreeOptedOut(task) && (
        <div className="px-6 py-2 border-b border-white/[0.05] shrink-0">
          <WorktreeWarning
            compact
            issue={(() => {
              try { return task.metadata ? JSON.parse(task.metadata).worktreeIssue : undefined } catch { return undefined }
            })()}
          />
        </div>
      )}

      {mergeOpen && <MergeModal task={task} open={mergeOpen} onClose={() => setMergeOpen(false)} onMerged={handleMerged} />}

      {/* Tabs */}
      <div className="flex items-center gap-0 px-6 border-b border-white/[0.06] bg-[#0d0d0d] shrink-0">
        {(
          [
            { id: 'chat', label: 'Chat' },
            { id: 'console', label: 'Console' },
            { id: 'timeline', label: 'Timeline' },
            { id: 'files', label: `Files (${task.changed_files_count})` },
            { id: 'notes', label: 'Notes' },
            { id: 'summary', label: 'Recap' }
          ] as { id: DetailTab; label: string }[]
        ).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'px-4 py-3 text-xs font-medium border-b-2 transition-all duration-100',
              activeTab === tab.id
                ? 'border-blue-500 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {/* A new agent means a new session: remount so commands, usage and pickers follow it. */}
        {activeTab === 'chat' && <ChatView key={task.process_type} task={task} />}

        {activeTab === 'console' && (
          <div className="h-full p-5">
            <SidecarConsole task={task} />
          </div>
        )}

        {activeTab === 'timeline' && (
          <div className="h-full overflow-y-auto px-6 py-4">
            <TaskTimeline taskId={task.id} />
          </div>
        )}

        {activeTab === 'files' && (
          <div className="h-full overflow-y-auto px-6 py-4">
            <FileChanges task={task} />
          </div>
        )}

        {activeTab === 'notes' && (
          <div className="h-full p-5">
            <div className="h-full flex flex-col gap-3">
              <p className="text-xs text-zinc-500">
                Task notes — visible only to you, stored locally.
              </p>
              <textarea
                className="flex-1 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-3 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-white/20 resize-none font-mono"
                placeholder="Add notes about this task, blockers, context..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-8 gap-1.5"
                  onClick={handleSaveNotes}
                >
                  <Save className="w-3 h-3" />
                  {notesSaved ? 'Saved!' : 'Save Notes'}
                </Button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'summary' && (
          <div className="h-full overflow-y-auto px-6 py-4">
            <SessionSummaryList summaries={summaries} recapping={recapping} onRecap={handleRecap} />
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center gap-3 px-6 py-2 border-t border-white/[0.05] bg-[#0d0d0d] shrink-0">
        <div className="flex items-center gap-1.5 text-[11px]">
          <StatusDot status={task.status} />
          <span className={statusCfg.color}>{statusCfg.label}</span>
        </div>
        <span className="text-zinc-700">·</span>
        <span className="text-[11px] text-zinc-600 font-mono">{task.id}</span>
        <div className="ml-auto flex items-center gap-2">
          {task.status === 'running' && (
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              Agent active
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function RuntimeDisplay({ task }: { task: Task }) {
  const [elapsed, setElapsed] = useState(task.runtime_seconds)

  useEffect(() => {
    if (task.status !== 'running' || !task.started_at) {
      setElapsed(task.runtime_seconds)
      return
    }
    const tick = () => {
      setElapsed(Math.floor(Date.now() / 1000) - task.started_at!)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [task.status, task.started_at, task.runtime_seconds])

  return <StatItem icon={<Clock className="w-3 h-3" />} label={formatDuration(elapsed)} />
}

function StatusDot({ status }: { status: Task['status'] }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span
      className={cn(
        'w-1.5 h-1.5 rounded-full shrink-0',
        cfg.dot,
        status === 'running' && 'animate-pulse'
      )}
    />
  )
}

function StatItem({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1 text-[11px] text-zinc-500">
      {icon}
      <span>{label}</span>
    </div>
  )
}

interface SessionSummaryEntry {
  session_id: string
  timestamp: string
  text?: string
  summary?: string[]      // legacy format
  modified_files: string[]
  commits: string[]
  status: 'completed' | 'waiting'
}

function RecapButton({ recapping, onRecap }: { recapping: boolean; onRecap: () => void }) {
  return (
    <Button variant="outline" size="sm" className="text-xs h-8 gap-1.5" disabled={recapping} onClick={onRecap}>
      {recapping ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
      {recapping ? 'Writing recap…' : 'Recap'}
    </Button>
  )
}

function SessionSummaryList({
  summaries,
  recapping,
  onRecap
}: {
  summaries: SessionSummaryEntry[]
  recapping: boolean
  onRecap: () => void
}) {
  const [copied, setCopied] = useState(false)

  if (!summaries.length) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3 text-zinc-600">
        <CheckCircle2 className="w-6 h-6 opacity-30" />
        <p className="text-xs">No recap yet — the agent writes one when you ask for it</p>
        <RecapButton recapping={recapping} onRecap={onRecap} />
      </div>
    )
  }

  // Always show the single latest summary
  const s = summaries[summaries.length - 1]
  const date = (() => { try { return new Date(s.timestamp).toLocaleString() } catch { return s.timestamp } })()
  const isCompleted = s.status === 'completed'

  const handleCopy = () => {
    const text = s.text ?? (Array.isArray(s.summary) ? s.summary.join('\n') : '')
    if (!text) return
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <RecapButton recapping={recapping} onRecap={onRecap} />
      </div>
      <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          {isCompleted
            ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            : <PauseCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
          <span className={cn('text-[11px] font-medium', isCompleted ? 'text-emerald-400' : 'text-amber-400')}>
            {isCompleted ? 'Completed' : 'Waiting for input'}
          </span>
          <span className="text-[11px] text-zinc-600 ml-auto">{date}</span>
          <button
            onClick={handleCopy}
            title="Copy recap"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        {/* Prose summary */}
        {s.text && (
          <p className="text-sm text-zinc-200 leading-relaxed selectable">{s.text}</p>
        )}

        {/* Legacy bullet list */}
        {!s.text && Array.isArray(s.summary) && s.summary.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {s.summary.map((item, j) => (
              <li key={j} className="flex items-start gap-2 text-xs text-zinc-300 selectable">
                <span className="mt-1.5 w-1 h-1 rounded-full bg-zinc-500 shrink-0" />
                {item}
              </li>
            ))}
          </ul>
        )}

        {/* Files */}
        {s.modified_files?.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">Modified files</span>
            <div className="flex flex-wrap gap-1.5">
              {s.modified_files.map((f) => (
                <span key={f} className="px-1.5 py-0.5 rounded text-[10px] font-mono text-zinc-400 bg-white/[0.04] border border-white/[0.06]">
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Commits */}
        {s.commits?.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <GitCommit className="w-3 h-3 text-zinc-600 shrink-0" />
            {s.commits.map((c) => (
              <span key={c} className="text-[10px] font-mono text-zinc-500">{c}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
