import React, { useState, useEffect, useCallback } from 'react'
import { Terminal, CheckCircle2, XCircle, FileText, Info, Gauge, RefreshCw, Download, LogIn, Workflow } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '../ui/dialog'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../stores/appStore'
import type { AgentDescriptor, AgentSettingDef, RateLimitInfo } from '../../types'
import { useUpdates } from '../../hooks/useUpdates'
import { describeStatus, StatusDot, useAuthStatus } from './SignInDialog'

const isElectron = typeof window !== 'undefined' && !!window.api

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

/** App-wide settings, not tied to one agent. */
const GENERAL_SETTINGS: AgentSettingDef[] = [
  {
    key: 'RELAY_NOTIFICATIONS',
    label: 'Notifications',
    description: 'Show a system notification when a chat task finishes or needs approval while the app is in the background.',
    type: 'boolean',
    default: true
  },
  {
    key: 'RELAY_AUTO_CONTINUE',
    label: 'Continue after a usage limit resets',
    description: 'When an agent stops on its 5-hour or weekly limit, the task continues by itself once the limit resets. You can cancel it in the chat.',
    type: 'boolean',
    default: true
  }
]

type SettingValue = boolean | string

function SettingRow({ def, value, onChange }: { def: AgentSettingDef; value: SettingValue; onChange: (key: string, next: SettingValue) => void }) {
  if (def.type === 'select') {
    return (
      <div className="flex flex-col gap-2 px-3 py-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
        <p className="text-xs font-medium text-zinc-200 leading-snug">{def.label}</p>
        <Select value={String(value)} onValueChange={(next) => onChange(def.key, next)}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {def.options.map((o) => (
              <SelectItem key={o.id} value={o.id} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-zinc-500 leading-relaxed">{def.description}</p>
      </div>
    )
  }
  const on = value === true
  return (
    <div className="flex items-start gap-3 px-3 py-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
      <button
        role="checkbox"
        aria-checked={on}
        onClick={() => onChange(def.key, !on)}
        className={cn(
          'relative mt-0.5 w-8 h-[18px] rounded-full transition-colors duration-200 shrink-0 focus:outline-none',
          on ? 'bg-violet-500' : 'bg-zinc-700'
        )}
      >
        <span className={cn(
          'absolute top-[2px] left-[2px] w-[14px] h-[14px] bg-white rounded-full shadow transition-transform duration-200',
          on ? 'translate-x-[14px]' : 'translate-x-0'
        )} />
      </button>
      <div>
        <p className="text-xs font-medium text-zinc-200 leading-snug">{def.label}</p>
        <p className="text-[11px] text-zinc-500 mt-1.5 leading-relaxed">{def.description}</p>
      </div>
    </div>
  )
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const agents = useAppStore((s) => s.agents)
  const loadAgents = useAppStore((s) => s.loadAgents)
  // Values of every agent-declared setting, keyed by settings key
  const [values, setValues] = useState<Record<string, SettingValue>>({})

  const selectable = agents.filter((a) => a.enabled)

  useEffect(() => {
    if (!open || !isElectron) return
    loadAgents()
  }, [open, loadAgents])

  // Load the persisted value of every setting declared by any agent
  useEffect(() => {
    if (!open || !isElectron) return
    let cancelled = false
    const defs = [...GENERAL_SETTINGS, ...agents.flatMap((a) => a.settings)]
    Promise.all(
      defs.map(async (def) => {
        const raw: string = await window.api.settings.get(def.key)
        const value: SettingValue = raw === '' ? def.default : def.type === 'select' ? raw : raw !== 'false'
        return [def.key, value] as const
      })
    ).then((entries) => {
      if (!cancelled) setValues(Object.fromEntries(entries))
    })
    return () => { cancelled = true }
  }, [open, agents])

  const change = useCallback((key: string, next: SettingValue) => {
    setValues((v) => ({ ...v, [key]: next }))
    if (isElectron) window.api.settings.set(key, String(next))
  }, [])

  const anySummaryAgent = selectable.some((a) => a.supportsSummaries && a.available)

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Relay Flowstate configuration and integration status.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 px-6 pb-6 pt-1 max-h-[70vh] overflow-y-auto">

          <UpdatesSection />

          <div className="h-px bg-white/[0.05]" />

          {/* General */}
          <div className="flex flex-col gap-3">
            {GENERAL_SETTINGS.map((def) => (
              <SettingRow key={def.key} def={def} value={values[def.key] ?? def.default} onChange={change} />
            ))}
          </div>

          <GlobalPipelineRow />

          <UsageLimits agents={selectable.filter((a) => a.available && a.chat?.limits)} open={open} />

          <div className="h-px bg-white/[0.05]" />

          {/* Agent CLI status */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-zinc-400" />
              <span className="text-sm font-medium text-zinc-200">Agents & accounts</span>
            </div>
            <p className="text-xs text-zinc-500 leading-relaxed">
              Agents run through your own installed CLI and its account. Sign in here
              instead of the agent's terminal. Session summaries are generated locally
              by whichever agent CLI is installed.
            </p>

            <div className="flex flex-col gap-2">
              {selectable.map((agent) => (
                <AgentStatusRow key={agent.id} agent={agent} open={open} />
              ))}
            </div>
          </div>

          <div className="h-px bg-white/[0.05]" />

          {/* Summary behaviour */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <FileText className="w-3.5 h-3.5 text-zinc-400" />
              <span className="text-sm font-medium text-zinc-200">Summary Generation</span>
            </div>
            <div className="flex flex-col gap-2">
              {[
                'Written only when you press Recap in a task',
                'Runs the agent CLI headlessly in the background (no terminal window)',
                'One recap per task — each one builds on the previous',
                anySummaryAgent
                  ? 'Falls back to a git-based summary if the CLI call fails'
                  : 'No agent CLI detected — summaries fall back to git history'
              ].map((item) => (
                <div key={item} className="flex items-start gap-2 text-xs text-zinc-400">
                  <Info className="w-3 h-3 text-zinc-600 mt-0.5 shrink-0" />
                  {item}
                </div>
              ))}
            </div>
          </div>

          {/* Per-agent launch options, declared by each agent definition */}
          {selectable
            .filter((a) => a.settings.length > 0)
            .map((agent) => (
              <React.Fragment key={agent.id}>
                <div className="h-px bg-white/[0.05]" />
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: agent.color }}
                    />
                    <span className="text-sm font-medium text-zinc-200">
                      {agent.label} Launch Options
                    </span>
                  </div>

                  {agent.settings.map((def) => (
                    <SettingRow key={def.key} def={def} value={values[def.key] ?? def.default} onChange={change} />
                  ))}
                </div>
              </React.Fragment>
            ))}

        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The app's version and its update from the GitHub releases. */
function GlobalPipelineRow() {
  const openGlobalPipeline = useAppStore((s) => s.openGlobalPipeline)
  return (
    <div className="flex items-start gap-3 px-3 py-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
      <Workflow className="w-3.5 h-3.5 mt-0.5 text-violet-300/80 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-zinc-200 leading-snug">Global pipeline</p>
        <p className="text-[11px] text-zinc-500 leading-relaxed mt-1">
          Steps around every chat message — review, commit, fix loops — for tasks without a pipeline of their own.
        </p>
      </div>
      <button
        onClick={openGlobalPipeline}
        className="shrink-0 h-7 px-2.5 rounded-md text-[11px] text-zinc-300 border border-white/[0.1] hover:bg-white/[0.05]"
      >
        Edit
      </button>
    </div>
  )
}

function UpdatesSection() {
  const u = useUpdates()
  if (!u) return null
  const busy = u.status === 'checking' || u.status === 'downloading'
  const button =
    u.status === 'ready'
      ? { label: u.mode === 'install' ? 'Restart to update' : 'Open installer', run: () => window.api.updates.install() }
      : u.status === 'available' && u.mode !== 'page'
        ? { label: 'Download', run: () => window.api.updates.download() }
        : u.status === 'available'
          ? { label: 'Open release page', run: () => window.api.updates.install() }
          : { label: 'Check for updates', run: () => window.api.updates.check() }
  return (
    <div className="flex flex-col gap-2 px-3 py-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
      <div className="flex items-center gap-2">
        <Download className="w-3.5 h-3.5 text-zinc-400" />
        <span className="text-xs font-medium text-zinc-200">Relay Flowstate {u.current}</span>
        <button
          onClick={() => void button.run()}
          disabled={busy}
          className="ml-auto h-7 px-3 rounded-lg text-[11.5px] font-medium border border-white/10 text-zinc-200 hover:bg-white/[0.06] disabled:opacity-50 flex items-center gap-1.5"
        >
          {busy && <RefreshCw className="w-3 h-3 animate-spin" />}
          {u.status === 'checking' ? 'Checking…' : u.status === 'downloading' ? `Downloading ${u.progress ?? 0}%` : button.label}
        </button>
      </div>
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        {u.status === 'up-to-date' && 'You have the latest version.'}
        {(u.status === 'available' || u.status === 'downloading') && (
          <>
            Version {u.version} is available.{' '}
            {u.notesUrl && (
              <a href={u.notesUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
                What's new
              </a>
            )}
          </>
        )}
        {u.status === 'ready' &&
          (u.mode === 'install'
            ? `Version ${u.version} is downloaded. The app restarts to install it; running tasks are stopped.`
            : `Version ${u.version} is downloaded. Open the installer, then drag Relay Flowstate into Applications and replace the old one. The app quits so it can be replaced; running tasks are stopped.`)}
        {u.status === 'error' && <span className="text-red-400/80">Update check failed: {u.error}</span>}
        {u.status === 'idle' && 'Updates come from the GitHub releases.'}
      </p>
    </div>
  )
}

type AccountLimits = { limits: RateLimitInfo[]; updatedAt: number }

function ago(at: number): string {
  const mins = Math.round((Date.now() - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours} h ago` : new Date(at).toLocaleDateString()
}

function resetText(at: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

/** Plan limits of each agent account: the last known values, then fresh ones from the CLI. */
function UsageLimits({ agents, open }: { agents: AgentDescriptor[]; open: boolean }) {
  const [limits, setLimits] = useState<Record<string, AccountLimits>>({})
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const ids = agents.map((a) => a.id).join(',')

  const refresh = useCallback((agentId: string) => {
    setLoading((s) => new Set(s).add(agentId))
    window.api.limits
      .refresh(agentId)
      .then((entry) => {
        if (entry) setLimits((l) => ({ ...l, [agentId]: entry }))
      })
      .catch(() => {})
      .finally(() =>
        setLoading((s) => {
          const next = new Set(s)
          next.delete(agentId)
          return next
        })
      )
  }, [])

  // Show what is known right away, and ask each CLI for the current numbers
  useEffect(() => {
    if (!open || !isElectron || !ids) return
    void window.api.limits.get().then(setLimits)
    for (const id of ids.split(',')) refresh(id)
  }, [open, ids, refresh])

  if (!agents.length) return null
  return (
    <>
      <div className="h-px bg-white/[0.05]" />
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Gauge className="w-3.5 h-3.5 text-zinc-400" />
          <span className="text-sm font-medium text-zinc-200">Usage limits</span>
        </div>
        {agents.map((agent) => {
          const entry = limits[agent.id]
          const busy = loading.has(agent.id)
          return (
            <div key={agent.id} className="flex flex-col gap-2 px-3 py-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: agent.color }} />
                <span className="text-xs font-medium text-zinc-200">{agent.label}</span>
                {entry && <span className="text-[10.5px] text-zinc-600">updated {ago(entry.updatedAt)}</span>}
                <button
                  onClick={() => refresh(agent.id)}
                  disabled={busy}
                  title="Refresh"
                  className="ml-auto p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05] disabled:opacity-50"
                >
                  <RefreshCw className={cn('w-3 h-3', busy && 'animate-spin')} />
                </button>
              </div>
              {entry?.limits.length ? (
                entry.limits.map((l) => {
                  const used = l.usedPercent ?? 0
                  return (
                    <div key={l.label} className="flex flex-col gap-1">
                      <div className="flex items-center text-[11px]">
                        <span className="text-zinc-300">{l.label}</span>
                        <span
                          className={cn(
                            'ml-auto',
                            l.status === 'blocked' ? 'text-red-400' : l.status === 'warning' ? 'text-amber-400' : 'text-zinc-400'
                          )}
                        >
                          {l.usedPercent != null ? `${l.usedPercent}% used` : l.status === 'blocked' ? 'limit reached' : '—'}
                          {l.resetsAt ? <span className="text-zinc-600"> · resets {resetText(l.resetsAt)}</span> : null}
                        </span>
                      </div>
                      <div className="h-1 rounded-full bg-white/[0.06] overflow-hidden">
                        <div
                          className={cn('h-full rounded-full', used >= 100 || l.status === 'blocked' ? 'bg-red-400/80' : used >= 80 ? 'bg-amber-400/80' : 'bg-zinc-400/70')}
                          style={{ width: `${Math.min(100, Math.max(used, 1))}%` }}
                        />
                      </div>
                    </div>
                  )
                })
              ) : (
                <p className="text-[11px] text-zinc-500">{busy ? 'Reading limits…' : 'No limits reported for this login (API keys have none).'}</p>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

function AgentStatusRow({ agent, open }: { agent: AgentDescriptor; open: boolean }) {
  const openSignIn = useAppStore((s) => s.openSignIn)
  const signInOpen = useAppStore((s) => s.signInAgentId === agent.id)
  const { status, refresh } = useAuthStatus(agent.available && open ? agent.id : null)

  // The dialog closing may mean a new sign-in
  useEffect(() => {
    if (!signInOpen && agent.available && open) void refresh()
  }, [signInOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!agent.available) {
    return (
      <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border bg-white/[0.02] border-white/[0.06]">
        <XCircle className="w-4 h-4 text-zinc-600 shrink-0" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-zinc-400">{agent.label} not found</p>
          <p className="text-[11px] text-zinc-600 mt-0.5">Install {agent.label} to run tasks with it</p>
        </div>
      </div>
    )
  }

  const needsSignIn = status?.signedIn === false
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 px-3 py-2.5 rounded-lg border',
        needsSignIn ? 'bg-amber-400/[0.04] border-amber-400/20' : 'bg-white/[0.02] border-white/[0.06]'
      )}
    >
      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: agent.color }} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-zinc-200 flex items-center gap-1.5">
          {agent.label}
          {status?.signedIn && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
        </p>
        <p className={cn('text-[11px] mt-0.5 truncate', needsSignIn ? 'text-amber-300/80' : 'text-zinc-500')}>
          <StatusDot status={status} /> {describeStatus(status)}
        </p>
      </div>
      {agent.loginMethods.length > 0 && (
        <button
          onClick={() => openSignIn(agent.id)}
          className={cn(
            'h-7 px-3 rounded-lg text-[11.5px] font-medium shrink-0 flex items-center gap-1.5 transition-colors',
            needsSignIn ? 'bg-white text-zinc-900 hover:bg-zinc-200' : 'border border-white/10 text-zinc-300 hover:bg-white/[0.06]'
          )}
        >
          <LogIn className="w-3 h-3" />
          {status?.signedIn ? 'Account' : 'Sign in'}
        </button>
      )}
    </div>
  )
}
