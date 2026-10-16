import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal as TerminalIcon, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../stores/appStore'
import type { Task } from '../../types'

// @xterm/xterm is a browser-compatible package — import directly
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

const isElectron = typeof window !== 'undefined' && !!window.api

/** Tells the user whether the agent picked up its previous conversation. */
function restartLabel(resumeMode?: string): string {
  if (resumeMode === 'session-id') return 'Session resumed'
  if (resumeMode === 'continue') return 'Continued latest conversation in this directory'
  return 'New session started'
}

const XTERM_THEME = {
  background: '#0a0a0a',
  foreground: '#e4e4e7',
  cursor: '#a1a1aa',
  cursorAccent: '#0a0a0a',
  selectionBackground: '#3f3f4680',
  black: '#18181b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#fafafa'
}

interface TerminalProps {
  task: Task
  className?: string
}

export function Terminal({ task, className }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const updateTask = useAppStore((s) => s.updateTask)
  const [restarting, setRestarting] = useState(false)
  const [noSession, setNoSession] = useState(false)

  const attachPty = useCallback((xterm: XTerm) => {
    let agentDone = false

    const unsubAgentExit = window.api.pty.onAgentExit
      ? window.api.pty.onAgentExit(task.id, (status) => {
          agentDone = true
          updateTask(task.id, { status, updated_at: Math.floor(Date.now() / 1000) })
        })
      : () => {}

    const unsubStatus = window.api.pty.onStatusChange
      ? window.api.pty.onStatusChange(task.id, (status) => {
          agentDone = true
          updateTask(task.id, { status, updated_at: Math.floor(Date.now() / 1000) })
          if (status === 'waiting') {
            xterm.write('\r\n\x1b[33m⏸ Waiting for input\x1b[0m\r\n')
          } else if (status === 'completed') {
            // no terminal message
          } else if (status === 'running') {
            agentDone = false
            updateTask(task.id, { status: 'running', updated_at: Math.floor(Date.now() / 1000) })
          }
        })
      : () => {}

    const unsubData = window.api.pty.onData(task.id, (data) => {
      xterm.write(data)
    })
    const unsubExit = window.api.pty.onExit(task.id, (exitCode) => {
      const msg =
        exitCode === 0
          ? '\r\n\x1b[32m✓ Session completed\x1b[0m\r\n'
          : `\r\n\x1b[31m✗ Session exited (code ${exitCode})\x1b[0m\r\n`
      xterm.write(msg)
      // Don't overwrite status if agent already marked the task completed
      if (!agentDone) {
        const status = exitCode === 0 ? 'completed' : 'failed'
        updateTask(task.id, { status, updated_at: Math.floor(Date.now() / 1000) })
      }
    })
    // Dispose xterm.onData on cleanup — otherwise multiple handlers accumulate on re-attach
    const onDataDisposable = xterm.onData((data) => {
      window.api.pty.write(task.id, data)
    })
    return () => { unsubAgentExit(); unsubStatus(); unsubData(); unsubExit(); onDataDisposable.dispose() }
  }, [task.id, updateTask])

  const handleRestart = useCallback(async () => {
    if (!isElectron || !xtermRef.current) return
    setRestarting(true)
    try {
      const res = await window.api.pty.restart(task.id, xtermRef.current.cols, xtermRef.current.rows)
      updateTask(task.id, { status: 'running', updated_at: Math.floor(Date.now() / 1000) })
      setNoSession(false)
      xtermRef.current.write(`\r\n\x1b[90m─── ${restartLabel(res?.resumeMode)} ───\x1b[0m\r\n`)
    } catch (e) {
      xtermRef.current.write(`\r\n\x1b[31m✗ Failed to restart: ${e}\x1b[0m\r\n`)
    } finally {
      setRestarting(false)
    }
  }, [task.id, updateTask])

  useEffect(() => {
    if (!containerRef.current) return

    const xterm = new XTerm({
      theme: XTERM_THEME,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 12,
      lineHeight: 1.5,
      cursorBlink: true,
      scrollback: 100000,  // keep full history in memory
      allowProposedApi: true
      // convertEol intentionally omitted — agent TUIs manage their own line endings via \r\n
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()
    xterm.loadAddon(fitAddon)
    xterm.loadAddon(webLinksAddon)
    xterm.open(containerRef.current)

    // Right-click: copy selection if text is selected, otherwise paste from clipboard
    containerRef.current.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      const sel = xterm.getSelection()
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {})
        xterm.clearSelection()
      } else {
        navigator.clipboard.readText().then((t) => { if (t) xterm.paste(t) }).catch(() => {})
      }
    })

    xterm.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      // Block Ctrl+V from being typed into xterm — paste is handled by the
      // capture-phase paste listener below which fires before xterm's own handler
      if (e.ctrlKey && e.key === 'v' && e.type === 'keydown') return false
      return true
    })

    // Intercept paste in capture phase — fires BEFORE xterm's bubble-phase listener,
    // so we call xterm.paste() exactly once and xterm never sees the raw event.
    // Works for both Ctrl+V and right-click → Paste.
    if (xterm.textarea) {
      xterm.textarea.addEventListener('paste', (e) => {
        e.preventDefault()
        e.stopImmediatePropagation()
        const text = e.clipboardData?.getData('text/plain')
        if (text) {
          xterm.paste(text)
        } else {
          // Fallback for environments where clipboardData is unavailable
          navigator.clipboard.readText().then((t) => { if (t) xterm.paste(t) }).catch(() => {})
        }
      }, true /* capture */)
    }

    xtermRef.current = xterm
    fitAddonRef.current = fitAddon

    if (!isElectron) {
      xterm.write('\x1b[90m[Running in browser — PTY not available]\x1b[0m\r\n')
      return () => {
        xterm.dispose()
        xtermRef.current = null
        fitAddonRef.current = null
      }
    }

    let detach = () => {}

    // Start the session immediately — don't block on font loading.
    // Fonts only affect rendering quality; the PTY session must start ASAP.
    ;(window.api.tasks.getLogs(task.id) as Promise<Array<{ data: string }>>)
      .then(async (logs) => {
        // 1. Write historical logs — concatenate into one write for performance
        if (logs.length > 0) {
          xterm.write(logs.map((l) => l.data).join(''))
        }

        // 2. Attach live PTY handlers BEFORE starting the session so we
        //    never miss data that arrives between restart() and attach().
        detach = attachPty(xterm)

        // 3. Check live session and start one if missing
        const sessions: string[] = await window.api.pty.sessions()
        const hasSession = sessions.includes(`pty-${task.id}`)

        if (!hasSession && task.status === 'running') {
          // Verify DB status before auto-restarting — the React store may be stale
          // if the session completed naturally while this component wasn't mounted.
          const freshTask = await (window.api.tasks.getById(task.id) as Promise<{ status: string } | null>)
          if (freshTask?.status === 'running') {
            try {
              const res = await window.api.pty.restart(task.id, xterm.cols, xterm.rows)
              updateTask(task.id, { status: 'running', updated_at: Math.floor(Date.now() / 1000) })
              if (logs.length > 0) {
                xterm.write(`\r\n\x1b[90m─── ${restartLabel(res?.resumeMode)} ───\x1b[0m\r\n`)
              }
            } catch {
              xterm.write('\r\n\x1b[31m✗ Could not resume session — use Restart button\x1b[0m\r\n')
            }
          } else {
            // Task is no longer running in DB — sync store and show restart prompt
            if (freshTask?.status) {
              updateTask(task.id, { status: freshTask.status as Task['status'], updated_at: Math.floor(Date.now() / 1000) })
            }
            setNoSession(true)
            xterm.write('\r\n\x1b[1;33m⚠ No active session — click Restart to resume\x1b[0m\r\n')
          }
        } else if (!hasSession) {
          setNoSession(true)
          xterm.write('\r\n\x1b[1;33m⚠ No active session — click Restart to resume\x1b[0m\r\n')
        }
      })

    // Fit with correct font metrics once fonts are ready, then keep PTY in sync.
    // Done separately so it never blocks session startup.
    document.fonts.ready.then(() => {
      fitAddon.fit()
      if (isElectron) window.api.pty.resize(task.id, xterm.cols, xterm.rows)
    })

    // Resize on container size change
    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        if (isElectron) window.api.pty.resize(task.id, xterm.cols, xterm.rows)
      } catch {
        // ignore if element is detached
      }
    })
    observer.observe(containerRef.current)

    return () => {
      detach()
      observer.disconnect()
      xterm.dispose()
      xtermRef.current = null
      fitAddonRef.current = null
    }
  }, [task.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn('flex flex-col rounded-xl overflow-hidden border border-white/[0.06]', className)}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-black/40 border-b border-white/[0.05] shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500/40" />
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500/40" />
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/40" />
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 ml-2">
          <TerminalIcon className="w-3 h-3" />
          <span>Session · {task.id.slice(0, 8)}</span>
        </div>
        {isElectron && (
          <button
            onClick={handleRestart}
            disabled={restarting}
            title="Restart session"
            className={cn(
              'ml-auto flex items-center gap-1.5 text-[10px] transition-colors disabled:opacity-40 px-1.5 py-0.5 rounded',
              noSession
                ? 'text-amber-400 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 ring-1 ring-amber-500/30'
                : 'text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.05]'
            )}
          >
            <RefreshCw className={cn('w-3 h-3', restarting && 'animate-spin')} />
            {restarting ? 'Restarting...' : 'Restart'}
          </button>
        )}
        {!isElectron && <span className="ml-auto text-[10px] text-zinc-700">Select text to copy</span>}
      </div>

      {/* xterm viewport */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 bg-[#0a0a0a]"
        style={{ padding: '8px' }}
      />
    </div>
  )
}
