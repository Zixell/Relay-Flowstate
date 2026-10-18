import React, { useState, useEffect, useCallback } from 'react'
import { Terminal, CheckCircle2, XCircle, FileText, Info } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '../ui/dialog'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../stores/appStore'
import type { AgentDescriptor, AgentSettingDef } from '../../types'

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
  }
]

function SettingRow({ def, value, onToggle }: { def: AgentSettingDef; value: boolean; onToggle: (key: string, next: boolean) => void }) {
  return (
    <div className="flex items-start gap-3 px-3 py-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
      <button
        role="checkbox"
        aria-checked={value}
        onClick={() => onToggle(def.key, !value)}
        className={cn(
          'relative mt-0.5 w-8 h-[18px] rounded-full transition-colors duration-200 shrink-0 focus:outline-none',
          value ? 'bg-violet-500' : 'bg-zinc-700'
        )}
      >
        <span className={cn(
          'absolute top-[2px] left-[2px] w-[14px] h-[14px] bg-white rounded-full shadow transition-transform duration-200',
          value ? 'translate-x-[14px]' : 'translate-x-0'
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
  const [values, setValues] = useState<Record<string, boolean>>({})

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
        return [def.key, raw === '' ? def.default : raw !== 'false'] as const
      })
    ).then((entries) => {
      if (!cancelled) setValues(Object.fromEntries(entries))
    })
    return () => { cancelled = true }
  }, [open, agents])

  const toggle = useCallback((key: string, next: boolean) => {
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

          {/* General */}
          <div className="flex flex-col gap-3">
            {GENERAL_SETTINGS.map((def) => (
              <SettingRow key={def.key} def={def} value={values[def.key] ?? def.default} onToggle={toggle} />
            ))}
          </div>

          <div className="h-px bg-white/[0.05]" />

          {/* Agent CLI status */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-zinc-400" />
              <span className="text-sm font-medium text-zinc-200">Agent CLIs</span>
            </div>
            <p className="text-xs text-zinc-500 leading-relaxed">
              Agents run through your own installed CLI and its login. Session summaries
              are generated locally by whichever agent CLI is installed.
            </p>

            <div className="flex flex-col gap-2">
              {selectable.map((agent) => (
                <AgentStatusRow key={agent.id} agent={agent} />
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
                'Written after each finished turn of a chat task',
                'Runs the agent CLI headlessly in the background (no terminal window)',
                'One summary per task — updated incrementally after each session',
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
                    <SettingRow key={def.key} def={def} value={values[def.key] ?? def.default} onToggle={toggle} />
                  ))}
                </div>
              </React.Fragment>
            ))}

        </div>
      </DialogContent>
    </Dialog>
  )
}

function AgentStatusRow({ agent }: { agent: AgentDescriptor }) {
  return (
    <div className={cn(
      'flex items-center gap-2.5 px-3 py-2.5 rounded-lg border',
      agent.available
        ? 'bg-emerald-400/5 border-emerald-400/20'
        : 'bg-red-400/5 border-red-400/20'
    )}>
      {agent.available
        ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
        : <XCircle className="w-4 h-4 text-red-400 shrink-0" />}
      <div className="min-w-0">
        <p className={cn(
          'text-xs font-medium',
          agent.available ? 'text-emerald-400' : 'text-red-400'
        )}>
          {agent.label} {agent.available ? 'detected' : 'not found'}
        </p>
        <p className="text-[11px] text-zinc-500 mt-0.5">
          {agent.available
            ? [
                agent.chat?.images ? 'images' : null,
                agent.chat?.forkFromTurn ? 'fork from any turn' : null,
                agent.supportsSummaries ? 'summaries' : null
              ].filter(Boolean).join(' · ') || 'ready'
            : `Install ${agent.label} to run tasks with it`}
        </p>
      </div>
    </div>
  )
}
