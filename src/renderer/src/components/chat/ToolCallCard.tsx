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
  X
} from 'lucide-react'
import { diffLines } from 'diff'
import { cn } from '../../lib/utils'
import type { ChatMessage, FileDiff, ToolCallContent, ToolKind } from '../../types'

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

function DiffView({ diff }: { diff: FileDiff }) {
  const lines = useMemo(() => {
    const out: { type: 'add' | 'del' | 'ctx'; text: string }[] = []
    for (const part of diffLines(diff.oldText ?? '', diff.newText ?? '')) {
      const type = part.added ? 'add' : part.removed ? 'del' : 'ctx'
      const rows = part.value.replace(/\n$/, '').split('\n')
      // Keep unchanged context short so the change stays in view.
      const shown = type === 'ctx' && rows.length > 6 ? [...rows.slice(0, 3), '⋯', ...rows.slice(-3)] : rows
      for (const text of shown) out.push({ type, text })
    }
    return out
  }, [diff.oldText, diff.newText])

  return (
    <div className="font-mono text-[11.5px] leading-[1.55] overflow-x-auto">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            'px-3 whitespace-pre',
            l.type === 'add' && 'bg-emerald-500/10 text-emerald-300',
            l.type === 'del' && 'bg-red-500/10 text-red-300',
            l.type === 'ctx' && 'text-zinc-500'
          )}
        >
          <span className="select-none inline-block w-3 opacity-60">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
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

export const ToolCallCard = memo(function ToolCallCard({ message }: { message: ChatMessage }) {
  const tool = useMemo<ToolCallContent>(() => {
    try {
      return JSON.parse(message.content ?? '{}')
    } catch {
      return { kind: 'other', name: 'tool', title: 'tool', input: {} }
    }
  }, [message.content])

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

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.015] overflow-hidden">
      <button
        onClick={() => expandable && setOpen((o) => !o)}
        className={cn(
          'w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px]',
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

      {open && (
        <div className="border-t border-white/[0.05] bg-black/30">
          {command && (
            <pre className="px-3 py-2 font-mono text-[11.5px] text-zinc-200 whitespace-pre-wrap break-all border-b border-white/[0.04]">
              <span className="text-zinc-600 select-none">$ </span>
              {command}
            </pre>
          )}
          {hasDiff
            ? tool.diff!.map((d, i) => <DiffView key={i} diff={d} />)
            : tool.output && <Output text={tool.output} />}
          {hasDiff && status === 'error' && tool.output && <Output text={tool.output} />}
        </div>
      )}
    </div>
  )
})
