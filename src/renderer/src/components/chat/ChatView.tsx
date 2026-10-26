import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Brain,
  ChevronRight,
  AlertTriangle,
  ImageOff,
  Loader2,
  FileCode,
  Undo2,
  CircleDot,
  CheckCircle2,
  Circle,
  GitFork,
  TerminalSquare,
  Bot,
  Activity,
  XCircle,
  Square
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useChat } from '../../hooks/useChat'
import { useAppStore } from '../../stores/appStore'
import type { BackgroundTask, ChatMessage, PlanItem, SessionUsage, Task, TurnInfo } from '../../types'
import { Markdown } from './Markdown'
import { ToolCallCard } from './ToolCallCard'
import { PermissionPrompt } from './PermissionPrompt'
import { Composer } from './Composer'
import { TurnChanges } from './TurnChanges'
import { HandoffDivider, LimitBanner, hitUsageLimit, resumeAtOf } from './AgentSwitch'

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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

function TurnFooter({
  taskId,
  turn,
  onRevert,
  onFork
}: {
  taskId: string
  turn: TurnInfo
  onRevert: () => void
  /** Present when this turn can be forked. */
  onFork?: () => Promise<void>
}) {
  const [showChanges, setShowChanges] = useState(false)
  const [forking, setForking] = useState(false)
  const usage = useMemo(() => {
    try {
      return turn.usage_json ? (JSON.parse(turn.usage_json) as { durationMs?: number; inputTokens?: number; outputTokens?: number }) : null
    } catch {
      return null
    }
  }, [turn.usage_json])
  const adds = turn.files.reduce((n, f) => n + f.additions, 0)
  const dels = turn.files.reduce((n, f) => n + f.deletions, 0)
  return (
    <>
    <div className="flex items-center gap-3 text-[11px] text-zinc-600 pl-1">
      {turn.status === 'interrupted' && <span className="text-zinc-500">Interrupted</span>}
      {turn.status === 'failed' && <span className="text-red-400/80">Failed</span>}
      {usage?.durationMs != null && <span>{Math.round(usage.durationMs / 1000)}s</span>}
      {usage?.outputTokens != null && (
        <span title={`${usage.inputTokens ?? 0} input / ${usage.outputTokens} output tokens`}>
          {formatTokens(usage.inputTokens ?? 0)} in · {formatTokens(usage.outputTokens)} out
        </span>
      )}
      {turn.files.length > 0 && (
        <>
          <button
            onClick={() => setShowChanges((v) => !v)}
            className={cn('flex items-center gap-1 hover:text-zinc-300', showChanges && 'text-zinc-300')}
            title="Show what this turn changed"
          >
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
      {onFork && (
        <button
          onClick={async () => {
            setForking(true)
            try {
              await onFork()
            } finally {
              setForking(false)
            }
          }}
          disabled={forking}
          className="flex items-center gap-1 hover:text-zinc-300 disabled:opacity-60"
          title="Start a new task from this point: the conversation so far and the files as they were after this turn"
        >
          {forking ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitFork className="w-3 h-3" />}
          Fork
        </button>
      )}
    </div>
    {showChanges && turn.files.length > 0 && (
      <div className="mt-2">
        <TurnChanges taskId={taskId} turn={turn} />
      </div>
    )}
    </>
  )
}

/** Context fill, plan limits and cost of the session, under the composer. */
function UsageBar({ usage, costUsd }: { usage: SessionUsage | null; costUsd?: number }) {
  const ctx = usage?.contextUsed != null && usage.contextSize ? Math.min(100, Math.round((usage.contextUsed / usage.contextSize) * 100)) : null
  // A limit with neither a figure nor a warning says nothing worth the space.
  const limits = (usage?.limits ?? []).filter((l) => l.usedPercent != null || (l.status && l.status !== 'ok'))
  if (ctx == null && !limits.length && costUsd == null) return null
  return (
    <div className="mt-1.5 flex items-center gap-3 text-[10.5px] text-zinc-600 px-1">
      {ctx != null && (
        <span className="flex items-center gap-1.5" title={`${usage!.contextUsed!.toLocaleString()} of ${usage!.contextSize!.toLocaleString()} tokens in context`}>
          <span className="relative w-12 h-1 rounded-full bg-white/[0.06] overflow-hidden">
            <span
              className={cn('absolute inset-y-0 left-0 rounded-full', ctx >= 85 ? 'bg-red-400/70' : ctx >= 60 ? 'bg-amber-400/70' : 'bg-zinc-500')}
              style={{ width: `${Math.max(ctx, 2)}%` }}
            />
          </span>
          Context {ctx}% · {formatTokens(usage!.contextUsed!)} / {formatTokens(usage!.contextSize!)}
        </span>
      )}
      {limits.map((l) => (
        <span
          key={l.label}
          className={cn(l.status === 'blocked' ? 'text-red-400/80' : l.status === 'warning' ? 'text-amber-400/80' : undefined)}
          title={l.resetsAt ? `Resets ${new Date(l.resetsAt).toLocaleString()}` : undefined}
        >
          {l.label} {l.usedPercent != null ? `${l.usedPercent}%` : l.status === 'blocked' ? 'limit reached' : ''}
        </span>
      ))}
      {costUsd != null && <span className="ml-auto">Session ≈ ${costUsd.toFixed(2)}</span>}
    </div>
  )
}

function PlanPanel({ items }: { items: PlanItem[] }) {
  const done = items.filter((i) => i.status === 'done').length
  // A finished plan (e.g. restored after a restart) stays out of the way.
  const [open, setOpen] = useState(done < items.length)
  if (!items.length) return null
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

/** Commands and subagents the agent left running, with a Stop for each. */
function BackgroundPanel({ taskId, tasks }: { taskId: string; tasks: BackgroundTask[] }) {
  const [open, setOpen] = useState(true)
  const [stopping, setStopping] = useState<Set<string>>(new Set())
  if (!tasks.length) return null
  const running = tasks.filter((t) => t.status === 'running').length
  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#0f0f0f] mb-3">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-zinc-400">
        <ChevronRight className={cn('w-3 h-3 transition-transform', open && 'rotate-90')} />
        Background
        <span className="text-zinc-600">{running ? `${running} running` : 'done'}</span>
        {running > 0 && <Loader2 className="w-3 h-3 animate-spin text-zinc-600" />}
      </button>
      {open && (
        <ul className="px-3 pb-2.5 space-y-1.5">
          {tasks.map((t) => {
            const Icon = t.type === 'shell' ? TerminalSquare : t.type.startsWith('agent') ? Bot : Activity
            const label = t.command ?? t.description
            return (
              <li key={t.id} className="flex items-start gap-2 text-[12px]">
                {t.status === 'running' ? (
                  <Icon className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
                ) : t.status === 'completed' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500/80 mt-0.5 shrink-0" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <div className={cn('truncate', t.command && 'font-mono text-[11.5px]', t.status === 'running' ? 'text-zinc-200' : 'text-zinc-500')} title={label}>
                    {label}
                  </div>
                  <div className="text-[11px] text-zinc-600 truncate" title={t.summary}>
                    {t.type}
                    {t.status !== 'running' && ` · ${t.status}`}
                    {t.summary && ` · ${t.summary}`}
                  </div>
                </div>
                {t.status === 'running' && (
                  <button
                    disabled={stopping.has(t.id)}
                    onClick={async () => {
                      setStopping((s) => new Set(s).add(t.id))
                      await window.api.chat.stopBackground(taskId, t.id).catch(() =>
                        setStopping((s) => {
                          const next = new Set(s)
                          next.delete(t.id)
                          return next
                        })
                      )
                    }}
                    title="Stop this task"
                    className="shrink-0 flex items-center gap-1 h-6 px-2 rounded-md text-[11px] text-zinc-400 border border-white/[0.08] hover:text-zinc-200 hover:bg-white/[0.05] disabled:opacity-50"
                  >
                    {stopping.has(t.id) ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-2.5 h-2.5" />}
                    Stop
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

interface Props {
  task: Task
}

const MESSAGE_WINDOW = 150

export function ChatView({ task }: Props) {
  const { state, turns, loading, send, interrupt, respondPermission, refreshTurns } = useChat(task.id)
  const agents = useAppStore((s) => s.agents)
  const updateTask = useAppStore((s) => s.updateTask)
  const loadData = useAppStore((s) => s.loadData)
  const selectTask = useAppStore((s) => s.selectTask)
  const capabilities = agents.find((a) => a.id === task.process_type)?.chat
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [viewerSrc, setViewerSrc] = useState<string | null>(null)
  // Long chats render only their tail; older messages load on demand.
  const [windowSize, setWindowSize] = useState(MESSAGE_WINDOW)
  const anchorHeight = useRef<number | null>(null)

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
    if (!el) return
    if (anchorHeight.current != null) {
      // Older messages were prepended: keep the view where it was.
      el.scrollTop += el.scrollHeight - anchorHeight.current
      anchorHeight.current = null
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [state.messages, state.streaming, loading, windowSize])

  useEffect(() => {
    stickToBottom.current = true
    setWindowSize(MESSAGE_WINDOW)
  }, [task.id])

  const windowStart = Math.max(0, state.messages.length - windowSize)
  const showEarlier = (): void => {
    anchorHeight.current = scrollRef.current?.scrollHeight ?? null
    setWindowSize((n) => n + MESSAGE_WINDOW)
  }

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

  const lastTurnId = useMemo(() => [...turns].reverse().find((t) => t.status !== 'running')?.id, [turns])
  const handoff = useMemo(() => {
    try {
      return task.metadata ? (JSON.parse(task.metadata).handoff as { fromLabel: string; at: number; pending: boolean } | undefined) : undefined
    } catch {
      return undefined
    }
  }, [task.metadata])
  const canFork = (turn: TurnInfo): boolean =>
    !state.inTurn &&
    Boolean(turn.commit_after) &&
    // Turns before a switch belong to the previous agent's session.
    !(handoff && turn.started_at < handoff.at) &&
    (Boolean(capabilities?.forkFromTurn && turn.checkpoint) || turn.id === lastTurnId)

  const lastError = useMemo(() => {
    const last = state.messages[state.messages.length - 1]
    return last?.kind === 'error' ? last.content : null
  }, [state.messages])
  const limitHit = !state.inTurn && (hitUsageLimit(lastError, state.usage?.limits) || resumeAtOf(task) !== undefined)
  const handoffSuggestion = handoff?.pending ? `Continue where ${handoff.fromLabel} stopped.` : null

  const handleFork = useCallback(
    async (turn: TurnInfo) => {
      try {
        const forked = (await window.api.chat.fork(task.id, turn.id)) as Task
        await loadData()
        selectTask(forked.id)
      } catch (err) {
        window.alert(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
      }
    },
    [task.id, loadData, selectTask]
  )

  const renderMessage = (m: ChatMessage): React.ReactNode => {
    switch (m.kind) {
      case 'text':
        return m.role === 'user' ? <UserBubble message={m} onOpenImage={setViewerSrc} /> : <Markdown text={m.content ?? ''} />
      case 'thinking':
        return <Thinking text={m.content ?? ''} />
      case 'tool_call':
        return (
          <ToolCallCard
            message={m}
            onBackground={
              capabilities?.background && m.tool_status === 'running' && m.tool_call_id
                ? () => window.api.chat.moveToBackground(task.id, m.tool_call_id!)
                : undefined
            }
          />
        )
      case 'permission':
        return <PermissionPrompt message={m} onRespond={respondPermission} active={m.id === lastPendingPermission} />
      case 'handoff':
        return <HandoffDivider content={m.content} />
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
        <div className="max-w-3xl mx-auto px-6 py-6 selectable">
          {loading && (
            <div className="flex justify-center py-10">
              <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
            </div>
          )}
          {windowStart > 0 && (
            <div className="flex justify-center mb-4">
              <button onClick={showEarlier} className="text-[11.5px] text-zinc-500 hover:text-zinc-300 px-3 py-1 rounded-full border border-white/[0.06] hover:bg-white/[0.03]">
                Show {Math.min(windowStart, MESSAGE_WINDOW)} earlier message{Math.min(windowStart, MESSAGE_WINDOW) === 1 ? '' : 's'}
              </button>
            </div>
          )}
          {state.messages.slice(windowStart).map((m, j) => {
            const i = j + windowStart
            return (
            <React.Fragment key={m.id}>
              <div className={cn('chat-item', i > windowStart && spacing(m, state.messages[i - 1]))}>{renderMessage(m)}</div>
              {turnEnds.has(i) && (
                <div className="mt-2">
                  <TurnFooter
                    taskId={task.id}
                    turn={turnEnds.get(i)!}
                    onRevert={() => handleRevert(turnEnds.get(i)!)}
                    onFork={canFork(turnEnds.get(i)!) ? () => handleFork(turnEnds.get(i)!) : undefined}
                  />
                </div>
              )}
            </React.Fragment>
            )
          })}
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
          {limitHit && <LimitBanner task={task} />}
          <BackgroundPanel taskId={task.id} tasks={state.background} />
          <PlanPanel items={state.plan} />
          <Composer
            inTurn={state.inTurn}
            capabilities={capabilities}
            commands={state.commands}
            taskId={task.id}
            suggestion={state.suggestion ?? handoffSuggestion}
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
          <UsageBar usage={state.usage} costUsd={state.costUsd} />
        </div>
      </div>
    </div>
  )
}
