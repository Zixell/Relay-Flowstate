import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Brain, ChevronRight, AlertTriangle, ImageOff, Loader2, FileCode, Undo2, CircleDot, CheckCircle2, Circle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useChat } from '../../hooks/useChat'
import { useAppStore } from '../../stores/appStore'
import type { ChatMessage, PlanItem, Task, TurnInfo } from '../../types'
import { Markdown } from './Markdown'
import { ToolCallCard } from './ToolCallCard'
import { PermissionPrompt } from './PermissionPrompt'
import { Composer } from './Composer'

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-[12px]">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-zinc-500 hover:text-zinc-300">
        <ChevronRight className={cn('w-3 h-3 transition-transform', open && 'rotate-90')} />
        <Brain className="w-3.5 h-3.5" />
        Thinking
      </button>
      {open && <div className="mt-1.5 pl-5 text-zinc-500 whitespace-pre-wrap leading-relaxed">{text}</div>}
    </div>
  )
}

/** Loaded attachment images, shared across re-renders and task switches. */
const attachmentCache = new Map<string, Promise<string | null>>()

function AttachmentThumb({ taskId, id, onOpen }: { taskId: string; id: string; onOpen: (src: string) => void }) {
  const [src, setSrc] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let alive = true
    if (!attachmentCache.has(id)) attachmentCache.set(id, window.api.chat.attachment(taskId, id))
    attachmentCache.get(id)!.then((url) => {
      if (!alive) return
      if (url) setSrc(url)
      else setMissing(true)
    })
    return () => {
      alive = false
    }
  }, [taskId, id])

  if (missing) {
    return (
      <div className="h-20 w-20 rounded-xl border border-white/10 bg-white/[0.03] flex items-center justify-center text-zinc-600">
        <ImageOff className="w-4 h-4" />
      </div>
    )
  }
  return src ? (
    <button onClick={() => onOpen(src)} className="block rounded-xl overflow-hidden border border-white/10 hover:border-white/25 transition-colors">
      <img src={src} className="h-20 max-w-[160px] object-cover" />
    </button>
  ) : (
    <div className="h-20 w-20 rounded-xl border border-white/10 bg-white/[0.03] animate-pulse" />
  )
}

function UserBubble({ message, onOpenImage }: { message: ChatMessage; onOpenImage: (src: string) => void }) {
  const attachments = useMemo<{ id: string }[]>(() => {
    try {
      return message.attachments ? JSON.parse(message.attachments) : []
    } catch {
      return []
    }
  }, [message.attachments])

  return (
    <div className="flex flex-col items-end gap-1.5">
      {attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5 max-w-[85%]">
          {attachments.map((a) => (
            <AttachmentThumb key={a.id} taskId={message.task_id} id={a.id} onOpen={onOpenImage} />
          ))}
        </div>
      )}
      {message.content && (
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-white/[0.07] border border-white/[0.06] px-4 py-2.5 text-[13px] text-zinc-100 whitespace-pre-wrap break-words leading-relaxed">
          {message.content}
        </div>
      )}
    </div>
  )
}

function ImageViewer({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div onClick={onClose} className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-10 cursor-zoom-out">
      <img src={src} className="max-w-full max-h-full rounded-lg shadow-2xl" />
    </div>
  )
}

function TurnFooter({ turn, onRevert, onShowFiles }: { turn: TurnInfo; onRevert: () => void; onShowFiles: () => void }) {
  const usage = useMemo(() => {
    try {
      return turn.usage_json ? (JSON.parse(turn.usage_json) as { durationMs?: number }) : null
    } catch {
      return null
    }
  }, [turn.usage_json])
  const adds = turn.files.reduce((n, f) => n + f.additions, 0)
  const dels = turn.files.reduce((n, f) => n + f.deletions, 0)
  return (
    <div className="flex items-center gap-3 text-[11px] text-zinc-600 pl-1">
      {turn.status === 'interrupted' && <span className="text-zinc-500">Interrupted</span>}
      {turn.status === 'failed' && <span className="text-red-400/80">Failed</span>}
      {usage?.durationMs != null && <span>{Math.round(usage.durationMs / 1000)}s</span>}
      {turn.files.length > 0 && (
        <>
          <button onClick={onShowFiles} className="flex items-center gap-1 hover:text-zinc-300">
            <FileCode className="w-3 h-3" />
            {turn.files.length} file{turn.files.length === 1 ? '' : 's'}
            <span className="text-emerald-500/70">+{adds}</span>
            <span className="text-red-400/70">−{dels}</span>
          </button>
          <button onClick={onRevert} className="flex items-center gap-1 hover:text-zinc-300" title="Restore files to the state before this turn">
            <Undo2 className="w-3 h-3" />
            Revert
          </button>
        </>
      )}
    </div>
  )
}

function PlanPanel({ items }: { items: PlanItem[] }) {
  const [open, setOpen] = useState(true)
  if (!items.length) return null
  const done = items.filter((i) => i.status === 'done').length
  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#0f0f0f] mb-3">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-zinc-400">
        <ChevronRight className={cn('w-3 h-3 transition-transform', open && 'rotate-90')} />
        Plan
        <span className="text-zinc-600">
          {done}/{items.length}
        </span>
      </button>
      {open && (
        <ul className="px-3 pb-2.5 space-y-1">
          {items.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px]">
              {item.status === 'done' ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500/80 mt-0.5 shrink-0" />
              ) : item.status === 'in_progress' ? (
                <CircleDot className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
              ) : (
                <Circle className="w-3.5 h-3.5 text-zinc-600 mt-0.5 shrink-0" />
              )}
              <span className={cn(item.status === 'done' ? 'text-zinc-500 line-through' : item.status === 'in_progress' ? 'text-zinc-100' : 'text-zinc-400')}>
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface Props {
  task: Task
  onShowFiles: () => void
}

export function ChatView({ task, onShowFiles }: Props) {
  const { state, turns, loading, send, interrupt, respondPermission, refreshTurns } = useChat(task.id)
  const agents = useAppStore((s) => s.agents)
  const updateTask = useAppStore((s) => s.updateTask)
  const capabilities = agents.find((a) => a.id === task.process_type)?.chat
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [viewerSrc, setViewerSrc] = useState<string | null>(null)

  const turnById = useMemo(() => new Map(turns.map((t) => [t.id, t])), [turns])

  // Index of the last message of each turn, where its footer goes.
  const turnEnds = useMemo(() => {
    const ends = new Map<number, TurnInfo>()
    state.messages.forEach((m, i) => {
      const turn = m.turn_id ? turnById.get(m.turn_id) : undefined
      if (turn && turn.status !== 'running') ends.set(i, turn)
    })
    // Keep only the last index per turn.
    const lastIndex = new Map<string, number>()
    for (const [i, t] of ends) lastIndex.set(t.id, i)
    return new Map([...lastIndex].map(([id, i]) => [i, turnById.get(id)!]))
  }, [state.messages, turnById])

  const lastPendingPermission = useMemo(() => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i]
      if (m.kind === 'permission' && m.tool_status === 'pending') return m.id
    }
    return null
  }, [state.messages])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [state.messages, state.streaming, loading])

  useEffect(() => {
    stickToBottom.current = true
  }, [task.id])

  const handleSend = useCallback(
    (text: string, images: { mediaType: string; data: string }[]) => {
      stickToBottom.current = true
      updateTask(task.id, { status: 'running', updated_at: Math.floor(Date.now() / 1000) })
      void send(text, images)
    },
    [send, task.id, updateTask]
  )

  const handleRevert = useCallback(
    async (turn: TurnInfo) => {
      if (!window.confirm(`Restore ${turn.files.length} file(s) to the state before this turn?`)) return
      await window.api.turns.revert(task.id, turn.id)
      await refreshTurns()
    },
    [task.id, refreshTurns]
  )

  const renderMessage = (m: ChatMessage): React.ReactNode => {
    switch (m.kind) {
      case 'text':
        return m.role === 'user' ? <UserBubble message={m} onOpenImage={setViewerSrc} /> : <Markdown text={m.content ?? ''} />
      case 'thinking':
        return <Thinking text={m.content ?? ''} />
      case 'tool_call':
        return <ToolCallCard message={m} />
      case 'permission':
        return <PermissionPrompt message={m} onRespond={respondPermission} active={m.id === lastPendingPermission} />
      case 'error':
        return (
          <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-300">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span className="whitespace-pre-wrap break-words">{m.content}</span>
          </div>
        )
      default:
        return null
    }
  }

  const spacing = (m: ChatMessage, prev?: ChatMessage): string => {
    if (!prev) return ''
    if (m.role === 'user' || prev.role === 'user') return 'mt-6'
    if (m.kind === 'tool_call' && prev.kind === 'tool_call') return 'mt-1'
    return 'mt-3'
  }

  const showWorking = state.inTurn && state.streamingOrder.length === 0 && !lastPendingPermission

  return (
    <div className="flex flex-col h-full">
      {viewerSrc && <ImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-6">
          {loading && (
            <div className="flex justify-center py-10">
              <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
            </div>
          )}
          {state.messages.map((m, i) => (
            <React.Fragment key={m.id}>
              <div className={spacing(m, state.messages[i - 1])}>{renderMessage(m)}</div>
              {turnEnds.has(i) && (
                <div className="mt-2">
                  <TurnFooter turn={turnEnds.get(i)!} onRevert={() => handleRevert(turnEnds.get(i)!)} onShowFiles={onShowFiles} />
                </div>
              )}
            </React.Fragment>
          ))}
          {state.streamingOrder.map((id) => (
            <div key={id} className="mt-3">
              <Markdown text={state.streaming[id] ?? ''} />
            </div>
          ))}
          {showWorking && (
            <div className="mt-4 flex items-center gap-2 text-[12px] text-zinc-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Working…
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-4 pt-2">
        <div className="max-w-3xl mx-auto">
          <PlanPanel items={state.plan} />
          <Composer
            inTurn={state.inTurn}
            capabilities={capabilities}
            model={task.model}
            mode={task.mode}
            onSend={handleSend}
            onInterrupt={() => void interrupt()}
            onModeChange={(mode) => {
              updateTask(task.id, { mode })
              void window.api.chat.setMode(task.id, mode)
            }}
            onModelChange={(model) => {
              updateTask(task.id, { model })
              void window.api.chat.setModel(task.id, model)
            }}
          />
          {state.costUsd != null && (
            <div className="mt-1.5 text-right text-[10.5px] text-zinc-700">Session cost ≈ ${state.costUsd.toFixed(2)}</div>
          )}
        </div>
      </div>
    </div>
  )
}
