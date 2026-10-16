import React, { useEffect, useRef, useState } from 'react'
import { Terminal as TerminalIcon, RotateCcw } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { Task } from '../../types'
import { XTERM_THEME } from './Terminal'

/**
 * Plain shell in the task's worktree, for the user's convenience only.
 * Nothing typed or printed here feeds the agent, the status or the history.
 */
export function SidecarConsole({ task }: { task: Task }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [generation, setGeneration] = useState(0)
  const [exited, setExited] = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    if (!containerRef.current || !window.api) return
    setExited(false)
    const xterm = new XTerm({
      theme: XTERM_THEME,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.loadAddon(new WebLinksAddon())
    xterm.open(containerRef.current)
    fit.fit()

    const unsubData = window.api.console.onData(task.id, (data) => xterm.write(data))
    const unsubExit = window.api.console.onExit(task.id, () => setExited(true))
    const input = xterm.onData((data) => void window.api.console.write(task.id, data))

    window.api.console.open(task.id, xterm.cols, xterm.rows).then(({ available, scrollback }) => {
      if (!available) setUnavailable(true)
      else if (scrollback) xterm.write(scrollback)
      xterm.focus()
    })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        void window.api.console.resize(task.id, xterm.cols, xterm.rows)
      } catch {
        // detached
      }
    })
    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      input.dispose()
      unsubData()
      unsubExit()
      xterm.dispose()
    }
  }, [task.id, generation])

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
        <div ref={containerRef} className="flex-1 min-h-0 bg-[#0a0a0a]" style={{ padding: 8 }} />
      )}
    </div>
  )
}
