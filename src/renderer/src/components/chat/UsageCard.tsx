import React, { useMemo, useState } from 'react'
import { Gauge, Lightbulb } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { RateLimitInfo } from '../../types'

/** Mirrors `UsageReport` in main/agents/adapter.ts. */
interface UsageActivity {
  label: string
  requests: number
  sessions: number
  tips: { pct: number; title: string; detail?: string }[]
  top: { label: string; items: { name: string; pct: number }[] }[]
}

interface UsageContent {
  agent: string
  report: { plan?: string; limits: RateLimitInfo[]; activity?: UsageActivity[] } | null
  error?: string
  session?: { costUsd?: number; contextUsed?: number; contextSize?: number }
  at: number
}

function resetText(at: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return `today ${time}`
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function LimitRow({ limit }: { limit: RateLimitInfo }) {
  const used = limit.usedPercent ?? 0
  const level = limit.status === 'blocked' || used >= 100 ? 'blocked' : limit.status === 'warning' || used >= 80 ? 'warning' : 'ok'
  return (
    <div className="grid grid-cols-[7.5rem_1fr_3rem] items-center gap-3">
      <span className="text-[12px] text-zinc-300 truncate" title={limit.label}>
        {limit.label}
      </span>
      <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            level === 'blocked' ? 'bg-red-400' : level === 'warning' ? 'bg-amber-400' : 'bg-emerald-400/80'
          )}
          style={{ width: `${Math.min(100, Math.max(used, 1.5))}%` }}
        />
      </div>
      <span
        className={cn(
          'text-right text-[12px] font-medium tabular-nums',
          level === 'blocked' ? 'text-red-300' : level === 'warning' ? 'text-amber-300' : 'text-zinc-200'
        )}
      >
        {limit.usedPercent != null ? `${limit.usedPercent}%` : '—'}
      </span>
      {limit.resetsAt ? <span className="col-start-2 col-span-2 -mt-1.5 text-[10.5px] text-zinc-600">resets {resetText(limit.resetsAt)}</span> : null}
    </div>
  )
}

/** `/usage` in a chat: plan limits, this chat's spend and what drives usage. */
export function UsageCard({ content }: { content: string | null }) {
  const data = useMemo<UsageContent | null>(() => {
    try {
      return content ? (JSON.parse(content) as UsageContent) : null
    } catch {
      return null
    }
  }, [content])
  const [period, setPeriod] = useState(0)
  if (!data) return null
  const { report, session } = data
  const activity = report?.activity?.[period]

  return (
    <div className="rounded-xl border border-white/[0.07] bg-gradient-to-b from-white/[0.035] to-white/[0.01] overflow-hidden">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2.5">
        <div className="w-6 h-6 rounded-md bg-emerald-400/10 border border-emerald-400/20 flex items-center justify-center">
          <Gauge className="w-3.5 h-3.5 text-emerald-300" />
        </div>
        <span className="text-[13px] font-medium text-zinc-100">Usage</span>
        <span className="text-[12px] text-zinc-500">{data.agent}</span>
        {report?.plan && (
          <span className="px-1.5 py-px rounded-md text-[10.5px] font-medium bg-violet-500/15 text-violet-300 border border-violet-400/20">{report.plan} plan</span>
        )}
        <span className="ml-auto text-[10.5px] text-zinc-600">{new Date(data.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>

      <div className="px-4 pb-3 space-y-2.5">
        {report?.limits.length ? (
          report.limits.map((l) => <LimitRow key={l.label} limit={l} />)
        ) : (
          <p className="text-[12px] text-zinc-500">
            {data.error ? `Could not read the limits: ${data.error}` : 'No plan limits for this sign-in — API keys are billed per use.'}
          </p>
        )}
      </div>

      {session && (session.costUsd != null || session.contextUsed != null) && (
        <div className="flex items-center gap-4 px-4 py-2 border-t border-white/[0.05] text-[11.5px] text-zinc-500">
          <span className="text-zinc-400">This chat</span>
          {session.costUsd != null && <span>${session.costUsd.toFixed(2)} at API prices</span>}
          {session.contextUsed != null && (
            <span>
              context {tokens(session.contextUsed)}
              {session.contextSize ? ` / ${tokens(session.contextSize)}` : ''}
            </span>
          )}
        </div>
      )}

      {report?.activity?.length ? (
        <div className="border-t border-white/[0.05] px-4 py-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-zinc-300">What uses your limits</span>
            <div className="ml-auto flex rounded-md border border-white/[0.08] p-0.5">
              {report.activity.map((a, i) => (
                <button
                  key={a.label}
                  onClick={() => setPeriod(i)}
                  className={cn('px-2 py-0.5 rounded text-[10.5px]', i === period ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
          {activity && (
            <>
              <p className="text-[11px] text-zinc-500">
                {activity.requests.toLocaleString()} requests · {activity.sessions} session{activity.sessions === 1 ? '' : 's'}
              </p>
              {activity.tips.length ? (
                <ul className="space-y-1.5">
                  {activity.tips.map((t) => (
                    <li key={t.title} className="grid grid-cols-[2.5rem_1fr] items-start gap-2">
                      <span className="text-right text-[12px] font-medium tabular-nums text-amber-300/90">{t.pct}%</span>
                      <span className="text-[12px] text-zinc-300 leading-snug">
                        <Lightbulb className="inline w-3 h-3 mr-1 -mt-0.5 text-amber-300/70" />
                        {t.title}
                        {t.detail && <span className="text-zinc-500"> · {t.detail}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-zinc-500">Nothing stands out.</p>
              )}
              {activity.top.length > 0 && (
                <div className="space-y-1 pt-0.5">
                  {activity.top.map((t) => (
                    <div key={t.label} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span className="text-zinc-500 w-20 shrink-0">{t.label}</span>
                      {t.items.map((i) => (
                        <span key={i.name} className="px-1.5 py-px rounded bg-white/[0.05] text-zinc-300 font-mono">
                          {i.name} <span className="text-zinc-500">{i.pct}%</span>
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[10.5px] text-zinc-600">Approximate · sessions on this machine only · shares overlap</p>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
