import React, { useEffect, useRef, useState } from 'react'
import { ArrowRightLeft, ChevronDown, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../stores/appStore'
import { processColor, processLabel, type Task } from '../../types'

/** Moves the task to another agent and refreshes it in the store. */
export async function switchTaskAgent(task: Task, agentId: string): Promise<void> {
  try {
    const updated = (await window.api.chat.switchAgent(task.id, agentId)) as Task | null
    if (updated) useAppStore.getState().updateTask(task.id, updated)
  } catch (err) {
    window.alert(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
  }
}

/** Agents the task could continue with: installed, chat-capable, not the current one. */
export function useOtherAgents(task: Task): { id: string; label: string; color: string }[] {
  const agents = useAppStore((s) => s.agents)
  return agents
    .filter((a) => a.id !== task.process_type && a.enabled && a.available)
    .map((a) => ({ id: a.id, label: a.label, color: processColor(a.id, agents) }))
}

/** The agent badge in the task header; opens a menu to continue with another agent. */
export function AgentPicker({ task, disabled }: { task: Task; disabled?: boolean }) {
  const agents = useAppStore((s) => s.agents)
  const others = useOtherAgents(task)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const color = processColor(task.process_type, agents)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        className="flex items-center gap-1.5 text-[11px] font-medium rounded px-1 -mx-1 hover:bg-white/[0.05]"
        style={{ color }}
        title="Continue this task with another agent"
      >
        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
        {processLabel(task.process_type, agents)}
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronDown className="w-3 h-3 opacity-60" />}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-30 w-64 rounded-xl border border-white/[0.09] bg-[#141414] shadow-2xl shadow-black/50 py-1">
          <div className="px-3 pt-1.5 pb-1 text-[10.5px] uppercase tracking-wider text-zinc-600">Continue with</div>
          {others.length === 0 && <div className="px-3 py-2 text-[12px] text-zinc-500">No other agent is installed</div>}
          {others.map((a) => (
            <button
              key={a.id}
              disabled={disabled}
              onClick={async () => {
                setOpen(false)
                setBusy(true)
                await switchTaskAgent(task, a.id)
                setBusy(false)
              }}
              className={cn('w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-zinc-200 hover:bg-white/[0.06]', disabled && 'opacity-50 cursor-not-allowed')}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: a.color }} />
              {a.label}
            </button>
          ))}
          <div className="px-3 pt-1.5 pb-1 text-[11px] text-zinc-600 leading-snug border-t border-white/[0.05] mt-1">
            {disabled
              ? 'Stop the current turn first.'
              : 'The worktree and history stay; the new agent gets the conversation so far with your next message.'}
          </div>
        </div>
      )}
    </div>
  )
}

/** Divider in the chat where the task moved to another agent. */
export function HandoffDivider({ content }: { content: string | null }) {
  let info: { fromLabel?: string; toLabel?: string } = {}
  try {
    info = content ? JSON.parse(content) : {}
  } catch {
    // keep defaults
  }
  return (
    <div className="flex items-center gap-3 my-2 text-[11px] text-zinc-500">
      <div className="flex-1 h-px bg-white/[0.06]" />
      <span className="flex items-center gap-1.5">
        <ArrowRightLeft className="w-3 h-3" />
        Continued with <span className="text-zinc-300">{info.toLabel}</span>
        <span className="text-zinc-600">· was {info.fromLabel}</span>
      </span>
      <div className="flex-1 h-px bg-white/[0.06]" />
    </div>
  )
}

/** Offered when the agent stopped on a usage limit: carry on with another one. */
export function LimitBanner({ task }: { task: Task }) {
  const agents = useAppStore((s) => s.agents)
  const others = useOtherAgents(task)
  const [busy, setBusy] = useState<string | null>(null)
  if (!others.length) return null
  return (
    <div className="mb-2 flex items-center gap-2 flex-wrap rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[12px]">
      <span className="text-amber-300">{processLabel(task.process_type, agents)} hit a usage limit.</span>
      <span className="text-zinc-400">Continue with</span>
      {others.map((a) => (
        <button
          key={a.id}
          disabled={busy !== null}
          onClick={async () => {
            setBusy(a.id)
            await switchTaskAgent(task, a.id)
            setBusy(null)
          }}
          className="flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-0.5 text-zinc-200 hover:bg-white/[0.06]"
        >
          {busy === a.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: a.color }} />}
          {a.label}
        </button>
      ))}
    </div>
  )
}

/** Detects that the last turn ended on a usage / rate limit. */
export function hitUsageLimit(lastError: string | null, limits?: { status?: string }[]): boolean {
  if (limits?.some((l) => l.status === 'blocked')) return true
  return Boolean(lastError && /usage limit|rate.?limit|quota|limit reached|out of credits|insufficient credits|429/i.test(lastError))
}
