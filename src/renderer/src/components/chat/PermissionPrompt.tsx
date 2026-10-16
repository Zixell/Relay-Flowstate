import React, { memo, useEffect, useMemo } from 'react'
import { ShieldQuestion, ShieldCheck, ShieldX } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ChatMessage, PermissionContent } from '../../types'

interface Props {
  message: ChatMessage
  onRespond: (requestId: string, optionId: string) => void
  /** Only the newest pending prompt listens to the 1/2/3 shortcuts. */
  active: boolean
}

export const PermissionPrompt = memo(function PermissionPrompt({ message, onRespond, active }: Props) {
  const content = useMemo<PermissionContent>(() => {
    try {
      return JSON.parse(message.content ?? '{}')
    } catch {
      return { title: 'Permission', options: [] }
    }
  }, [message.content])

  const status = message.tool_status
  const pending = status === 'pending'

  useEffect(() => {
    if (!pending || !active) return
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
      const n = Number(e.key)
      const option = content.options[n - 1]
      if (option) {
        e.preventDefault()
        onRespond(message.id, option.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, active, content.options, message.id, onRespond])

  if (!pending) {
    const denied = status === 'deny'
    const label = status === 'expired' ? 'Expired' : denied ? 'Denied' : status === 'allow_always' ? 'Always allowed' : 'Allowed'
    const Icon = denied || status === 'expired' ? ShieldX : ShieldCheck
    return (
      <div className="flex items-center gap-2 text-[11.5px] text-zinc-500 px-1">
        <Icon className={cn('w-3.5 h-3.5', denied ? 'text-red-400/70' : 'text-zinc-500')} />
        <span className="truncate">{content.title}</span>
        <span className="text-zinc-600">· {label}</span>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.04] p-3">
      <div className="flex items-start gap-2">
        <ShieldQuestion className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] text-zinc-100 font-medium break-words">{content.title}</div>
          {content.detail && <div className="text-[11.5px] text-zinc-400 mt-0.5 break-words">{content.detail}</div>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 mt-3 pl-6">
        {content.options.map((o, i) => (
          <button
            key={o.id}
            onClick={() => onRespond(message.id, o.id)}
            className={cn(
              'h-7 px-3 rounded-lg text-[12px] font-medium border transition-colors flex items-center gap-1.5',
              o.kind === 'deny'
                ? 'border-white/10 text-zinc-300 hover:bg-white/[0.06]'
                : i === 0
                  ? 'border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                  : 'border-amber-500/25 text-amber-300 hover:bg-amber-500/10'
            )}
          >
            {o.label}
            {active && <kbd className="text-[10px] text-zinc-500 font-mono">{i + 1}</kbd>}
          </button>
        ))}
      </div>
    </div>
  )
})
