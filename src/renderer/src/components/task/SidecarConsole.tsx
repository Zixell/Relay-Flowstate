import React, { useCallback, useState } from 'react'
import { Terminal as TerminalIcon, RotateCcw } from 'lucide-react'
import { TerminalPane } from '../ui/terminal-pane'
import type { Task } from '../../types'

/**
 * Plain shell in the task's worktree, for the user's convenience only.
 * Nothing typed or printed here feeds the agent, the status or the history.
 */
export function SidecarConsole({ task }: { task: Task }) {
  const [generation, setGeneration] = useState(0)
  const [exited, setExited] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  const open = useCallback(
    (cols: number, rows: number) => {
      setExited(false)
      return window.api.console.open(task.id, cols, rows)
    },
    [task.id]
  )

  return (
    <div className="flex flex-col h-full rounded-xl overflow-hidden border border-white/[0.06]">
      <div className="flex items-center gap-2 px-3 py-2 bg-black/40 border-b border-white/[0.05] shrink-0 text-[11px] text-zinc-600">
        <TerminalIcon className="w-3 h-3" />
        <span className="font-mono truncate">{task.worktree_path || task.project_path}</span>
        {exited && (
          <button
            onClick={() => setGeneration((g) => g + 1)}
            className="ml-auto flex items-center gap-1 text-zinc-400 hover:text-zinc-200"
          >
            <RotateCcw className="w-3 h-3" />
            New shell
          </button>
        )}
      </div>
      {unavailable ? (
        <div className="flex-1 flex items-center justify-center text-[12px] text-zinc-600">Console is unavailable: node-pty is not built.</div>
      ) : (
        <TerminalPane
          key={`${task.id}:${generation}`}
          consoleId={task.id}
          open={open}
          onUnavailable={() => setUnavailable(true)}
          onExit={() => setExited(true)}
          className="flex-1 min-h-0 bg-[#0a0a0a]"
        />
      )}
    </div>
  )
}
