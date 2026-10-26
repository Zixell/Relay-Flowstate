import React, { memo, useEffect, useMemo, useState } from 'react'
import { ShieldQuestion, ShieldCheck, ShieldX, MessageCircleQuestion, Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AgentQuestion, ChatMessage, PermissionContent } from '../../types'

interface Props {
  message: ChatMessage
  onRespond: (requestId: string, optionId: string, answers?: Record<string, string>) => void
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
    // Questions are answered with the mouse; a digit must not send an empty answer
    if (!pending || !active || content.questions) return
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
  }, [pending, active, content.options, content.questions, message.id, onRespond])

  if (content.questions) {
    return <QuestionPrompt message={message} content={content} questions={content.questions} onRespond={onRespond} />
  }

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

/** An agent's multiple-choice questions (Claude's AskUserQuestion), answered in place. */
function QuestionPrompt({
  message,
  content,
  questions,
  onRespond
}: {
  message: ChatMessage
  content: PermissionContent
  questions: AgentQuestion[]
  onRespond: Props['onRespond']
}) {
  const pending = message.tool_status === 'pending'
  // Picked option labels per question; OTHER stands for the free-text answer
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []))
  const [other, setOther] = useState<string[]>(() => questions.map(() => ''))

  if (!pending) {
    const skipped = !content.answers
    return (
      <div className="text-[11.5px] text-zinc-500 px-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <MessageCircleQuestion className="w-3.5 h-3.5" />
          <span>{skipped ? (message.tool_status === 'expired' ? 'Question expired' : 'Question skipped') : 'Answered'}</span>
        </div>
        {!skipped &&
          questions.map((q) => (
            <div key={q.question} className="pl-5 truncate">
              <span className="text-zinc-600">{q.header || q.question}:</span> <span className="text-zinc-300">{content.answers![q.question] ?? '—'}</span>
            </div>
          ))}
      </div>
    )
  }

  const toggle = (qi: number, label: string): void => {
    setPicked((prev) =>
      prev.map((p, i) => {
        if (i !== qi) return p
        if (!questions[qi].multiSelect) return [label]
        return p.includes(label) ? p.filter((l) => l !== label) : [...p, label]
      })
    )
  }

  const answerOf = (qi: number): string =>
    picked[qi]
      .map((l) => (l === OTHER ? other[qi].trim() : l))
      .filter(Boolean)
      .join(', ')
  const complete = questions.every((_, qi) => answerOf(qi))

  const submit = (): void => {
    if (!complete) return
    onRespond(message.id, 'answer', Object.fromEntries(questions.map((q, qi) => [q.question, answerOf(qi)])))
  }

  return (
    <div className="rounded-xl border border-blue-500/25 bg-blue-500/[0.04] p-3">
      <div className="flex items-center gap-2 text-[12.5px] text-zinc-100 font-medium">
        <MessageCircleQuestion className="w-4 h-4 text-blue-400 shrink-0" />
        {content.title}
      </div>
      <div className="mt-3 space-y-4 pl-6">
        {questions.map((q, qi) => (
          <div key={q.question}>
            {q.header && <div className="text-[10px] uppercase tracking-wide text-blue-300/80 mb-1">{q.header}</div>}
            <div className="text-[12.5px] text-zinc-100 mb-2 break-words">
              {q.question}
              {q.multiSelect && <span className="text-zinc-500 text-[11px]"> · pick any</span>}
            </div>
            <div className="space-y-1.5">
              {[...q.options, { label: OTHER, description: undefined }].map((o) => {
                const on = picked[qi].includes(o.label)
                return (
                  <div key={o.label}>
                    <button
                      onClick={() => toggle(qi, o.label)}
                      className={cn(
                        'w-full flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                        on ? 'border-blue-500/50 bg-blue-500/10' : 'border-white/[0.08] hover:border-white/[0.15] hover:bg-white/[0.03]'
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 w-3.5 h-3.5 shrink-0 border flex items-center justify-center',
                          q.multiSelect ? 'rounded' : 'rounded-full',
                          on ? 'border-blue-400 bg-blue-500 text-white' : 'border-zinc-600'
                        )}
                      >
                        {on && <Check className="w-2.5 h-2.5" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[12.5px] text-zinc-100">{o.label === OTHER ? 'Other' : o.label}</span>
                        {o.description && <span className="block text-[11.5px] text-zinc-400 leading-snug">{o.description}</span>}
                      </span>
                    </button>
                    {o.label === OTHER && on && (
                      <input
                        autoFocus
                        value={other[qi]}
                        onChange={(e) => setOther((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submit()
                        }}
                        placeholder="Your answer"
                        className="mt-1.5 w-full h-8 rounded-lg border border-white/[0.08] bg-black/30 px-3 text-[12.5px] text-zinc-100 outline-none focus:border-blue-500/50"
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-3 pl-6">
        <button
          onClick={submit}
          disabled={!complete}
          className="h-7 px-3 rounded-lg text-[12px] font-medium border border-blue-500/40 bg-blue-500/15 text-blue-200 hover:bg-blue-500/25 disabled:opacity-40 disabled:hover:bg-blue-500/15"
        >
          Send
        </button>
        <button
          onClick={() => onRespond(message.id, 'deny')}
          className="h-7 px-3 rounded-lg text-[12px] font-medium border border-white/10 text-zinc-300 hover:bg-white/[0.06]"
        >
          Skip
        </button>
      </div>
    </div>
  )
}

/** Stands in for the free-text answer among a question's picks. */
const OTHER = '\u0000other'
