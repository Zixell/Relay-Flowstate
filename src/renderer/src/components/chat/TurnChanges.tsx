import React, { useEffect, useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { TurnInfo } from '../../types'
import { DiffView } from './ToolCallCard'

type TurnFile = TurnInfo['files'][number]

const STATUS_MARK: Record<TurnFile['status'], { letter: string; cls: string }> = {
  added: { letter: 'A', cls: 'text-emerald-400/80' },
  modified: { letter: 'M', cls: 'text-amber-400/80' },
  deleted: { letter: 'D', cls: 'text-red-400/80' },
  renamed: { letter: 'R', cls: 'text-sky-400/80' }
}

function FileRow({ taskId, turnId, file, initiallyOpen }: { taskId: string; turnId: string; file: TurnFile; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const [patch, setPatch] = useState<string | null>(null)

  useEffect(() => {
    if (!open || patch !== null) return
    let alive = true
    window.api.turns.diff(taskId, turnId, file.path).then((text: string) => alive && setPatch(text))
    return () => {
      alive = false
    }
  }, [open, patch, taskId, turnId, file.path])

  const mark = STATUS_MARK[file.status]
  const binary = patch !== null && /^Binary files /m.test(patch)

  return (
    <div className="border-t border-white/[0.04] first:border-t-0">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11.5px] hover:bg-white/[0.03]">
        <ChevronRight className={cn('w-3 h-3 text-zinc-600 transition-transform shrink-0', open && 'rotate-90')} />
        <span className={cn('font-mono w-3 shrink-0', mark.cls)}>{mark.letter}</span>
        <span className="font-mono text-zinc-300 truncate" title={file.path}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px]">
          <span className="text-emerald-500/70">+{file.additions}</span> <span className="text-red-400/70">−{file.deletions}</span>
        </span>
      </button>
      {open && (
        <div className="bg-black/30 border-t border-white/[0.04] max-h-[420px] overflow-y-auto">
          {patch === null ? (
            <div className="px-3 py-2">
              <Loader2 className="w-3 h-3 animate-spin text-zinc-600" />
            </div>
          ) : binary ? (
            <div className="px-3 py-2 text-[11.5px] text-zinc-500">Binary file</div>
          ) : patch.trim() ? (
            <DiffView diff={{ path: file.path, patch }} />
          ) : (
            <div className="px-3 py-2 text-[11.5px] text-zinc-500">No textual changes</div>
          )}
        </div>
      )}
    </div>
  )
}

/** Files one turn changed, each expandable to its diff between the turn's snapshots. */
export function TurnChanges({ taskId, turn, autoOpen = true }: { taskId: string; turn: TurnInfo; autoOpen?: boolean }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.015] overflow-hidden">
      {turn.files.map((f) => (
        <FileRow key={f.path} taskId={taskId} turnId={turn.id} file={f} initiallyOpen={autoOpen && turn.files.length === 1} />
      ))}
    </div>
  )
}
