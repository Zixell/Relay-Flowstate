import React from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '../../lib/utils'

const REASONS: Record<string, { why: string; fix: string }> = {
  'not-git': {
    why: 'The project folder is not a git repository.',
    fix: 'Run git init and make a first commit to give each task its own worktree.'
  },
  'no-commits': {
    why: 'The repository has no commits yet, and a worktree needs one to branch from.',
    fix: 'Make a first commit (git commit --allow-empty -m init) to enable isolation.'
  }
}

/**
 * Shown when a task cannot get its own worktree: the agent then edits the
 * user's main checkout directly, and parallel tasks can overwrite each other.
 */
export function WorktreeWarning({ issue, compact }: { issue?: string | null; compact?: boolean }) {
  const reason = issue ? REASONS[issue] : undefined
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] text-amber-200/90',
        compact ? 'px-3 py-1.5 text-[11.5px]' : 'px-3 py-2.5 text-xs'
      )}
    >
      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-[1px]" />
      <div className="leading-relaxed">
        <span className="font-medium text-amber-200">
          {compact ? 'No isolated worktree — the agent works directly in your project folder.' : 'This task will run without an isolated worktree.'}
        </span>{' '}
        {!compact && 'The agent will change files in your project folder directly, and parallel tasks can overwrite each other. '}
        {reason ? (
          <span className="text-amber-200/70">
            {reason.why} {reason.fix}
          </span>
        ) : (
          issue && <span className="text-amber-200/70">{issue}</span>
        )}
      </div>
    </div>
  )
}
