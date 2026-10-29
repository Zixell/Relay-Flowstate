import React, { memo, useEffect, useMemo, useState } from 'react'
import {
  FileText,
  FilePen,
  FilePlus,
  TerminalSquare,
  Search,
  Globe,
  ListTodo,
  Bot,
  Plug,
  Wrench,
  ChevronRight,
  Loader2,
  Check,
  X,
  ArrowDownToLine
} from 'lucide-react'
import { diffLines } from 'diff'
import { cn } from '../../lib/utils'
import type { ChatMessage, FileDiff, ToolCallContent, ToolKind } from '../../types'
import { SubagentCard } from './SubagentCard'

const ICONS: Record<ToolKind, React.ComponentType<{ className?: string }>> = {
  read: FileText,
  edit: FilePen,
  write: FilePlus,
  bash: TerminalSquare,
  search: Search,
  fetch: Globe,
  todo: ListTodo,
  task: Bot,
  mcp: Plug,
  other: Wrench
}

const VERBS: Record<ToolKind, string> = {
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  bash: 'Run',
  search: 'Search',
  fetch: 'Fetch',
  todo: 'Plan',
  task: 'Agent',
  mcp: 'Tool',
  other: 'Tool'
}

function shortPath(p: string): string {
  const parts = p.split('/')
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : p
}

type DiffLine = { type: 'add' | 'del' | 'ctx' | 'hunk'; text: string }

/** Lines of a unified diff, without the file headers. */
function patchLines(patch: string): DiffLine[] {
  const out: DiffLine[] = []
  for (const line of patch.replace(/\n$/, '').split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('index ')) continue
    if (line.startsWith('@@')) out.push({ type: 'hunk', text: line.replace(/^(@@[^@]*@@).*/, '$1') })
    else if (line.startsWith('+')) out.push({ type: 'add', text: line.slice(1) })
    else if (line.startsWith('-')) out.push({ type: 'del', text: line.slice(1) })
    else if (!line.startsWith('\\')) out.push({ type: 'ctx', text: line.slice(1) })
  }
  return out
}

function DiffView({ diff, showPath }: { diff: FileDiff; showPath?: boolean }) {
  const lines = useMemo(() => {
    if (diff.patch != null && diff.oldText == null && diff.newText == null) return patchLines(diff.patch)
    const out: DiffLine[] = []
    for (const part of diffLines(diff.oldText ?? '', diff.newText ?? '')) {
      const type = part.added ? 'add' : part.removed ? 'del' : 'ctx'
      const rows = part.value.replace(/\n$/, '').split('\n')
      // Keep unchanged context short so the change stays in view.
      const shown = type === 'ctx' && rows.length > 6 ? [...rows.slice(0, 3), '⋯', ...rows.slice(-3)] : rows
      for (const text of shown) out.push({ type, text })
    }
    return out
  }, [diff.oldText, diff.newText, diff.patch])

  return (
    <div className="font-mono text-[11.5px] leading-[1.55] overflow-x-auto">
      {showPath && <div className="px-3 py-1 text-zinc-500 bg-white/[0.02] border-b border-white/[0.04]">{diff.path}</div>}
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            'px-3 whitespace-pre',
            l.type === 'add' && 'bg-emerald-500/10 text-emerald-300',
            l.type === 'del' && 'bg-red-500/10 text-red-300',
            l.type === 'ctx' && 'text-zinc-500',
            l.type === 'hunk' && 'text-sky-400/70 bg-sky-500/[0.04]'
          )}
        >
          <span className="select-none inline-block w-3 opacity-60">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : l.type === 'hunk' ? '' : ' '}</span>
          {l.text}
        </div>
      ))}
    </div>
  )
}

function Output({ text }: { text: string }) {
  return (
    <pre className="px-3 py-2 font-mono text-[11.5px] leading-[1.55] text-zinc-400 whitespace-pre-wrap break-all max-h-72 overflow-y-auto">
      {text}
    </pre>
  )
}

export { DiffView }

export const ToolCallCard = memo(function ToolCallCard({
  message,
  onBackground
}: {
  message: ChatMessage
  /** Offered while a command or subagent runs: let it carry on in the background. */
  onBackground?: () => Promise<unknown>
}) {
  const tool = useMemo<ToolCallContent>(() => {
    try {
      const parsed = JSON.parse(message.content ?? '{}')
      return { ...parsed, input: parsed.input ?? {} }
    } catch {
      return { kind: 'other', name: 'tool', title: 'tool', input: {} }
    }
  }, [message.content])

  return tool.kind === 'task' ? (
    <SubagentCard message={message} tool={tool} onBackground={onBackground} />
  ) : (
    <PlainToolCard message={message} tool={tool} onBackground={onBackground} />
  )
})

function PlainToolCard({
  message,
  tool,
  onBackground
}: {
  message: ChatMessage
  tool: ToolCallContent
  onBackground?: () => Promise<unknown>
}) {
  const status = message.tool_status
  const hasDiff = Boolean(tool.diff?.length)
  // Edits are what the user most wants to see, so they start open.
  const autoOpen = hasDiff && (tool.kind === 'edit' || tool.kind === 'write')
  const [open, setOpen] = useState(autoOpen)
  // The diff arrives with the tool result, after the card first rendered.
  useEffect(() => {
    if (autoOpen) setOpen(true)
  }, [autoOpen])
  const Icon = ICONS[tool.kind] ?? Wrench
  const isPath = tool.kind === 'read' || tool.kind === 'edit' || tool.kind === 'write'
  const command = tool.kind === 'bash' ? (tool.input.command as string | undefined) : undefined
  const expandable = hasDiff || Boolean(tool.output) || Boolean(command)
  // Only commands and subagents block the turn in a way the agent can step around
  const backgroundable = onBackground && status === 'running' && (tool.name === 'Bash' || tool.kind === 'task')
  const [backgrounding, setBackgrounding] = useState(false)

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.015] overflow-hidden">
      <div className="flex items-center">
      <button
        onClick={() => expandable && setOpen((o) => !o)}
        className={cn(
          'flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 text-left text-[12px]',
          expandable ? 'hover:bg-white/[0.03] cursor-pointer' : 'cursor-default'
        )}
      >
        <ChevronRight className={cn('w-3 h-3 text-zinc-600 transition-transform shrink-0', open && 'rotate-90', !expandable && 'opacity-0')} />
        <Icon className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
        <span className="text-zinc-400 shrink-0">{VERBS[tool.kind] ?? tool.name}</span>
        <span className={cn('text-zinc-300 truncate', isPath && 'font-mono text-[11.5px]')} title={tool.title}>
          {isPath ? shortPath(tool.title) : tool.title}
        </span>
        <span className="ml-auto shrink-0">
          {status === 'running' && <Loader2 className="w-3 h-3 animate-spin text-zinc-500" />}
          {status === 'ok' && <Check className="w-3 h-3 text-emerald-500/80" />}
          {status === 'error' && <X className="w-3 h-3 text-red-400" />}
        </span>
      </button>
      {backgroundable && (
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
          className="shrink-0 mr-1.5 flex items-center gap-1 h-6 px-2 rounded-md text-[11px] text-zinc-400 border border-white/[0.08] hover:text-zinc-200 hover:bg-white/[0.05] disabled:opacity-50"
        >
          <ArrowDownToLine className="w-3 h-3" />
          Run in background
        </button>
      )}
      </div>

      {open && (
        <div className="border-t border-white/[0.05] bg-black/30">
          {command && (
            <pre className="px-3 py-2 font-mono text-[11.5px] text-zinc-200 whitespace-pre-wrap break-all border-b border-white/[0.04]">
              <span className="text-zinc-600 select-none">$ </span>
              {command}
            </pre>
          )}
          {hasDiff
            ? tool.diff!.map((d, i) => <DiffView key={i} diff={d} showPath={tool.diff!.length > 1} />)
            : tool.output && <Output text={tool.output} />}
          {hasDiff && status === 'error' && tool.output && <Output text={tool.output} />}
        </div>
      )}
    </div>
  )
}
