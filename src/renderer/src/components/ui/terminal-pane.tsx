import React, { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

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

const isMac = navigator.platform.toUpperCase().includes('MAC')

/**
 * Copy and paste the way the platform's own terminal does. On macOS Cmd+C/V
 * come through the app menu. Elsewhere xterm would send Ctrl+V to the program
 * as a control character, so the browser is left to paste instead, and Ctrl+C
 * copies when text is selected, interrupting otherwise (Windows Terminal).
 */
function clipboardKeys(xterm: XTerm): (e: KeyboardEvent) => boolean {
  return (e) => {
    if (isMac || e.type !== 'keydown') return true
    const key = e.key.toLowerCase()
    if ((e.ctrlKey && key === 'v') || (e.shiftKey && e.key === 'Insert')) return false
    if (e.ctrlKey && key === 'c' && (e.shiftKey || xterm.hasSelection())) {
      if (xterm.hasSelection()) void navigator.clipboard.writeText(xterm.getSelection())
      xterm.clearSelection()
      e.preventDefault()
      return false
    }
    return true
  }
}

interface TerminalPaneProps {
  /** Console id whose data/exit events this pane shows. Changing it starts over. */
  consoleId: string
  /** Starts (or re-attaches to) the console at the pane's size. */
  open: (cols: number, rows: number) => Promise<{ available: boolean; scrollback: string }>
  onUnavailable?: () => void
  onExit?: () => void
  className?: string
}

/** An xterm wired to a console in the main process (see main/console/manager.ts). */
export function TerminalPane({ consoleId, open, onUnavailable, onExit, className }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Latest callbacks, without restarting the terminal when they change
  const cb = useRef({ open, onUnavailable, onExit })
  cb.current = { open, onUnavailable, onExit }

  useEffect(() => {
    const container = containerRef.current
    if (!container || !window.api) return
    const xterm = new XTerm({
      theme: XTERM_THEME,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    // The addon's default opens a blank window first, which the app turns away
    xterm.loadAddon(new WebLinksAddon((_, uri) => window.open(uri, '_blank')))
    xterm.attachCustomKeyEventHandler(clipboardKeys(xterm))
    xterm.open(container)
    fit.fit()

    // Right click: copy the selection, or paste when there is none
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      if (xterm.hasSelection()) {
        void navigator.clipboard.writeText(xterm.getSelection())
        xterm.clearSelection()
      } else {
        void navigator.clipboard.readText().then((text) => text && xterm.paste(text))
      }
      xterm.focus()
    }
    container.addEventListener('contextmenu', onContextMenu)

    const unsubData = window.api.console.onData(consoleId, (data) => xterm.write(data))
    const unsubExit = window.api.console.onExit(consoleId, () => cb.current.onExit?.())
    const input = xterm.onData((data) => void window.api.console.write(consoleId, data))

    cb.current
      .open(xterm.cols, xterm.rows)
      .then(({ available, scrollback }) => {
        if (!available) cb.current.onUnavailable?.()
        else if (scrollback) xterm.write(scrollback)
        xterm.focus()
      })
      .catch((err) => xterm.write(`\x1b[31m${err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : err}\x1b[0m\r\n`))

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
        void window.api.console.resize(consoleId, xterm.cols, xterm.rows)
      } catch {
        // detached
      }
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      container.removeEventListener('contextmenu', onContextMenu)
      input.dispose()
      unsubData()
      unsubExit()
      xterm.dispose()
    }
  }, [consoleId])

  return <div ref={containerRef} className={className} style={{ padding: 8 }} />
}
