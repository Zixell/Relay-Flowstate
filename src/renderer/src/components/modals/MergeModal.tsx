import React, { useState, useEffect } from 'react'
import { GitBranch, GitMerge, Info } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import type { Task } from '../../types'

interface MergeModalProps {
  task: Task
  open: boolean
  onClose: () => void
  onMerged: () => void
}

export function MergeModal({ task, open, onClose, onMerged }: MergeModalProps) {
  const [branches, setBranches] = useState<string[]>([])
  /** The branch the worktree came from; a new target is created from it. */
  const [source, setSource] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The target starts out as the branch the worktree came from
  useEffect(() => {
    if (!open) return
    setError(null)
    setLoaded(false)
    let alive = true
    Promise.all([window.api.git.getBranches(task.project_path), window.api.tasks.sourceBranch(task.id)])
      .then(([all, from]) => {
        if (!alive) return
        setBranches(all)
        setSource(from)
        setTarget(from ?? '')
      })
      .catch(() => setBranches([]))
      .finally(() => alive && setLoaded(true))
    return () => {
      alive = false
    }
  }, [open, task.id, task.project_path])

  const name = target.trim()
  const isNew = !!name && !branches.includes(name)
  const canMerge = loaded && !!name && (!isNew || !!source)

  const handleMerge = async () => {
    if (!task.worktree_path || !canMerge) return
    setMerging(true)
    setError(null)
    try {
      const stripped = name.replace(/^(feature|feat|fix|bugfix|hotfix|chore|refactor|docs|test|style|perf)\//, '')
      const commitMessage = `${stripped}: ${task.title}`
      const res = await window.api.git.commitAndMerge(task.id, task.worktree_path, task.project_path, name, commitMessage)
      if (res.success) {
        onMerged()
        onClose()
      } else {
        setError(res.stderr || 'Merge failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMerging(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !merging && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="w-4 h-4 text-blue-400" />
            Merge task
          </DialogTitle>
          <DialogDescription>
            The task's changes are committed and squashed into the branch as one commit.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pb-2 space-y-4">
          {source && (
            <div className="flex items-center gap-1.5 text-[12px] text-zinc-500">
              <GitBranch className="w-3.5 h-3.5" />
              Worktree created from
              <span className="font-mono text-zinc-300">{source}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-zinc-300">Merge into branch</label>
            <div className="relative">
              <GitBranch className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500 pointer-events-none" />
              <Input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleMerge()
                }}
                placeholder={source ? `${source} or a new branch name` : 'Branch name'}
                className="pl-8 font-mono"
                autoFocus
              />
            </div>
          </div>

          {loaded && name && (
            <div className="flex items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[12px] leading-relaxed text-zinc-400">
              <Info className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-[3px]" />
              <span>
                {isNew && !source ? (
                  <>
                    Branch <span className="font-mono text-zinc-200">{name}</span> doesn't exist, and the branch this task's worktree came from
                    is unknown, so it can't be created. Enter an existing branch.
                  </>
                ) : (
                  <>
                    {isNew ? (
                      <>
                        A new branch <span className="font-mono text-zinc-200">{name}</span> will be created from{' '}
                        <span className="font-mono text-zinc-200">{source}</span>, and the task's changes merged into it.
                      </>
                    ) : (
                      <>
                        The task's changes will be merged into <span className="font-mono text-zinc-200">{name}</span>.
                      </>
                    )}{' '}
                    The project folder is switched to this branch.
                  </>
                )}
              </span>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2 font-mono break-all">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={merging}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleMerge} disabled={!canMerge || merging} className="gap-1.5">
            {merging ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Merging...
              </>
            ) : (
              <>
                <GitMerge className="w-3.5 h-3.5" />
                {isNew ? 'Create & merge' : 'Merge'}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
