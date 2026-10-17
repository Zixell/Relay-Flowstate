import React, { useEffect, useMemo, useState } from 'react'
import { Download, Folder, GitBranch, Loader2, Search, AlertTriangle, ArrowRight } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { cn, formatRelativeTime } from '../../lib/utils'
import { useAppStore } from '../../stores/appStore'
import { processColor, type Task } from '../../types'

interface ImportableSession {
  agentId: string
  agentLabel: string
  sessionId: string
  title: string
  cwd: string
  updatedAt: number
  gitBranch?: string
  importedTaskId?: string
  cwdExists: boolean
  worktreeIssue: string | null
}

const WORKTREE_ISSUE_TEXT: Record<string, string> = {
  'not-git': 'not a git repository',
  'no-commits': 'the repository has no commits yet',
  missing: 'the directory no longer exists'
}

function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~')
}

export function ImportSessionsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const agents = useAppStore((s) => s.agents)
  const loadData = useAppStore((s) => s.loadData)
  const selectTask = useAppStore((s) => s.selectTask)
  const [sessions, setSessions] = useState<ImportableSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [agentFilter, setAgentFilter] = useState<string | null>(null)
  const [worktree, setWorktree] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSessions(null)
    setError(null)
    window.api.sessions
      .listExternal()
      .then((list: ImportableSession[]) => setSessions(list))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [open])

  const agentIds = useMemo(() => [...new Set((sessions ?? []).map((s) => s.agentId))], [sessions])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = (sessions ?? []).filter(
      (s) =>
        (!agentFilter || s.agentId === agentFilter) &&
        (!q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q))
    )
    const byCwd = new Map<string, ImportableSession[]>()
    for (const s of filtered) byCwd.set(s.cwd, [...(byCwd.get(s.cwd) ?? []), s])
    return [...byCwd.entries()]
  }, [sessions, query, agentFilter])

  const openTask = (taskId: string): void => {
    selectTask(taskId)
    onClose()
  }

  const runImport = async (s: ImportableSession): Promise<void> => {
    setImporting(s.sessionId)
    setError(null)
    try {
      const task = (await window.api.sessions.import({
        agentId: s.agentId,
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title,
        worktree
      })) as Task
      await loadData()
      openTask(task.id)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      setImporting(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import sessions</DialogTitle>
          <DialogDescription>
            Continue a conversation you started in an agent&apos;s own CLI. The history is copied into a chat task; the agent keeps its full context.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-6 space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
            <Input placeholder="Search by title or folder…" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8 h-8 text-xs" />
          </div>
          {agentIds.length > 1 && (
            <div className="flex items-center gap-1">
              {[null, ...agentIds].map((id) => (
                <button
                  key={id ?? 'all'}
                  onClick={() => setAgentFilter(id)}
                  className={cn(
                    'h-8 px-2.5 rounded-md text-[11.5px] border',
                    agentFilter === id ? 'border-white/20 bg-white/[0.06] text-zinc-100' : 'border-white/[0.06] text-zinc-500 hover:text-zinc-300'
                  )}
                >
                  {id ? sessions!.find((s) => s.agentId === id)!.agentLabel : 'All'}
                </button>
              ))}
            </div>
          )}
        </div>

        <label className="flex items-start gap-2.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 cursor-pointer">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} className="mt-0.5 accent-blue-500" />
          <span className="text-[12px] leading-relaxed">
            <span className="text-zinc-200">Continue in a new worktree</span>
            <span className="block text-zinc-500">
              {worktree
                ? 'The session is copied and continues on its own branch; the original stays untouched in the CLI. Uncommitted changes in the folder are not carried over.'
                : 'The session continues in its original folder, together with any uncommitted changes. No isolation from other work there.'}
            </span>
          </span>
        </label>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-300">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        <div className="max-h-[52vh] overflow-y-auto -mx-1 px-1 space-y-4">
          {sessions === null && !error && (
            <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-zinc-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Looking for sessions…
            </div>
          )}
          {sessions !== null && groups.length === 0 && (
            <div className="py-10 text-center text-[12px] text-zinc-500">
              {sessions.length ? 'Nothing matches the search.' : 'No sessions found. Sessions from Claude Code and Codex CLIs appear here.'}
            </div>
          )}
          {groups.map(([cwd, items]) => (
            <div key={cwd}>
              <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-zinc-500">
                <Folder className="w-3 h-3 shrink-0" />
                <span className="text-zinc-300 font-medium">{cwd.split('/').pop()}</span>
                <span className="font-mono truncate">{shortPath(cwd)}</span>
              </div>
              <div className="rounded-lg border border-white/[0.06] divide-y divide-white/[0.04]">
                {items.map((s) => {
                  const blocked = !s.cwdExists ? WORKTREE_ISSUE_TEXT.missing : worktree && s.worktreeIssue ? WORKTREE_ISSUE_TEXT[s.worktreeIssue] ?? s.worktreeIssue : null
                  return (
                    <div key={`${s.agentId}:${s.sessionId}`} className="flex items-center gap-3 px-3 py-2">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: processColor(s.agentId, agents) }} title={s.agentLabel} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] text-zinc-200 truncate" title={s.title}>
                          {s.title}
                        </div>
                        <div className="flex items-center gap-2.5 text-[10.5px] text-zinc-600">
                          <span>{s.agentLabel}</span>
                          <span>{formatRelativeTime(Math.floor(s.updatedAt / 1000))}</span>
                          {s.gitBranch && (
                            <span className="flex items-center gap-0.5 font-mono truncate">
                              <GitBranch className="w-2.5 h-2.5" />
                              {s.gitBranch}
                            </span>
                          )}
                          {blocked && <span className="text-amber-500/80">{blocked}</span>}
                        </div>
                      </div>
                      {s.importedTaskId ? (
                        <Button variant="ghost" size="sm" className="h-7 px-2.5 text-[11px] gap-1 shrink-0" onClick={() => openTask(s.importedTaskId!)}>
                          Imported
                          <ArrowRight className="w-3 h-3" />
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2.5 text-[11px] gap-1 shrink-0"
                          disabled={Boolean(blocked) || importing !== null}
                          onClick={() => void runImport(s)}
                        >
                          {importing === s.sessionId ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                          Import
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
