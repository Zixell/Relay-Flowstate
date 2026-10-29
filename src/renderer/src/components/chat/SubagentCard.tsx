import React, { useEffect, useState } from 'react'
import { ArrowDownToLine, Bot, Check, ChevronRight, Loader2, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ChatMessage, ToolCallContent } from '../../types'
import { Markdown } from './Markdown'

/** "1:05", "12s" */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** Seconds since `since` (unix seconds), ticking while `live`. */
function useElapsed(since: number, live: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  return now - since * 1000
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

/**
 * A subagent the agent launched: who it is, what it was asked, what it is
 * doing now and what it came back with. Set apart from plain tool calls so a
 * fan-out of agents is visible at a glance.
 */
export function SubagentCard({
  message,
  tool,
  onBackground
}: {
  message: ChatMessage
  tool: ToolCallContent
  onBackground?: () => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [backgrounding, setBackgrounding] = useState(false)
  const status = message.tool_status
  const running = status === 'running'
  const progress = tool.progress ?? {}
  const elapsed = useElapsed(message.created_at, running)

  const type = str(tool.input.subagent_type) ?? 'agent'
  const title = str(tool.input.description) ?? tool.title
  const prompt = str(tool.input.prompt)
  const duration = progress.durationMs ?? (running ? elapsed : undefined)
  const stats = [
    progress.toolUses ? `${progress.toolUses} tool${progress.toolUses === 1 ? '' : 's'}` : null,
    duration != null && duration > 1000 ? formatElapsed(duration) : null
  ].filter(Boolean)

  return (
    <div
      className={cn(
        'relative rounded-lg border overflow-hidden transition-colors',
        running ? 'border-violet-400/30 bg-violet-500/[0.06]' : 'border-violet-400/15 bg-violet-500/[0.03]'
      )}
    >
      <span className={cn('absolute inset-y-0 left-0 w-[2px]', running ? 'bg-violet-400/80 animate-pulse' : 'bg-violet-400/30')} />
      <div className="flex items-start">
        <button onClick={() => setOpen((o) => !o)} className="flex-1 min-w-0 flex items-start gap-2.5 pl-3 pr-3 py-2 text-left hover:bg-white/[0.02]">
          <div
            className={cn(
              'mt-0.5 w-6 h-6 rounded-md flex items-center justify-center shrink-0 border',
              running ? 'bg-violet-500/20 border-violet-400/30' : 'bg-violet-500/10 border-violet-400/15'
            )}
          >
            <Bot className="w-3.5 h-3.5 text-violet-300" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[10.5px]">
              <span className="uppercase tracking-wider font-semibold text-violet-300/90">Subagent</span>
              <span className="px-1.5 py-px rounded bg-white/[0.06] text-zinc-300 font-mono truncate max-w-[14rem]" title={type}>
                {type}
              </span>
              <span className="ml-auto shrink-0">
                <StatusChip status={status} background={progress.background} stopped={/^stopped$/i.test(tool.output ?? '')} />
              </span>
            </div>
            <div className="mt-1 text-[12.5px] text-zinc-200 truncate" title={title}>
              {title}
            </div>
            {(running || stats.length > 0) && (
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500 min-w-0">
                {running && progress.activity && (
                  <span className="truncate text-zinc-400" title={progress.activity}>
                    <span className="text-violet-400/70">▸</span> {progress.activity}
                  </span>
                )}
                {running && !progress.activity && !stats.length && <span>Starting…</span>}
                {stats.length > 0 && (
                  <span className="shrink-0">
                    {running && progress.activity ? '· ' : ''}
                    {stats.join(' · ')}
                  </span>
                )}
              </div>
            )}
          </div>
          <ChevronRight className={cn('mt-1.5 w-3 h-3 text-zinc-600 transition-transform shrink-0', open && 'rotate-90')} />
        </button>
        {onBackground && running && !progress.background && (
          <button
            disabled={backgrounding}
            onClick={async () => {
              setBackgrounding(true)
              try {
                await onBackground()
              } finally {
                setBackgrounding(false)
              }
            }}
            title="Let it keep running in the background; the agent carries on and is told when it finishes"
            className="shrink-0 mt-2 mr-2 flex items-center gap-1 h-6 px-2 rounded-md text-[11px] text-zinc-400 border border-white/[0.08] hover:text-zinc-200 hover:bg-white/[0.05] disabled:opacity-50"
          >
            <ArrowDownToLine className="w-3 h-3" />
            Background
          </button>
        )}
      </div>

      {open && (
        <div className="border-t border-violet-400/10 bg-black/25 px-3 py-2.5 space-y-3">
          {prompt && (
            <section>
              <p className="text-[10.5px] uppercase tracking-wider text-zinc-500 mb-1">Task</p>
              <div className="text-[12px] text-zinc-300 whitespace-pre-wrap break-words max-h-56 overflow-y-auto selectable">{prompt}</div>
            </section>
          )}
          <section>
            <p className="text-[10.5px] uppercase tracking-wider text-zinc-500 mb-1">Result</p>
            {tool.output ? (
              <div className="max-h-80 overflow-y-auto text-[12.5px] selectable">
                <Markdown text={tool.output} />
              </div>
            ) : (
              <p className="text-[12px] text-zinc-600">{running ? 'Still working…' : 'No result reported.'}</p>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

function StatusChip({ status, background, stopped }: { status: string | null; background?: boolean; stopped?: boolean }) {
  if (status === 'running') {
    return background ? (
      <span className="flex items-center gap-1 text-violet-300">
        <span className="relative flex w-1.5 h-1.5">
          <span className="absolute inset-0 rounded-full bg-violet-400 animate-ping opacity-60" />
          <span className="relative w-1.5 h-1.5 rounded-full bg-violet-400" />
        </span>
        In background
      </span>
    ) : (
      <span className="flex items-center gap-1 text-violet-300">
        <Loader2 className="w-3 h-3 animate-spin" />
        Working
      </span>
    )
  }
  if (status === 'ok') {
    return (
      <span className="flex items-center gap-1 text-emerald-400/90">
        <Check className="w-3 h-3" />
        Done
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 text-red-400/90">
      <X className="w-3 h-3" />
      {stopped ? 'Stopped' : 'Failed'}
    </span>
  )
}
