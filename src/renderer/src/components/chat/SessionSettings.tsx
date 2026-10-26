import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { SessionSettingDef } from '../../types'

type Value = string | boolean

interface Props {
  taskId: string
  defs: SessionSettingDef[]
  /** What the task set; an absent key follows the agent's own configuration. */
  values: Record<string, Value>
  onChange: (key: string, value: Value | null) => void
  onClose: () => void
}

const segment = (on: boolean): string =>
  cn(
    'h-6 px-2.5 text-[11px] rounded-md transition-colors',
    on ? 'bg-white/[0.12] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
  )

/** The chat's /config: the task's session settings, each with a Default that leaves the agent's own. */
export function SessionSettings({ taskId, defs, values, onChange, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [extra, setExtra] = useState<Record<string, { id: string; label: string }[]>>({})

  // Choices only the running agent knows, e.g. custom output styles
  useEffect(() => {
    void window.api.chat.sessionSettingOptions(taskId).then(setExtra).catch(() => {})
  }, [taskId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 right-0 mb-2 z-30 rounded-xl border border-white/[0.08] bg-[#141414] shadow-2xl max-h-[60vh] overflow-y-auto"
    >
      <div className="flex items-center px-3 pt-2.5 pb-1.5">
        <span className="text-[12px] font-medium text-zinc-200">Session settings</span>
        <span className="ml-2 text-[11px] text-zinc-600">this task · Default keeps your Claude config</span>
        <button onClick={onClose} className="ml-auto p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05]">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="px-3 pb-3 divide-y divide-white/[0.05]">
        {defs.map((def) => {
          const value = values[def.key]
          const set = value !== undefined
          return (
            <div key={def.key} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-zinc-200">{def.label}</div>
                <div className="text-[11px] text-zinc-500 leading-snug">{def.description}</div>
              </div>
              {def.type === 'boolean' && (
                <div className="shrink-0 flex items-center gap-0.5 rounded-lg bg-white/[0.04] p-0.5">
                  <button className={segment(!set)} onClick={() => onChange(def.key, null)}>
                    Default
                  </button>
                  <button className={segment(value === true)} onClick={() => onChange(def.key, true)}>
                    On
                  </button>
                  <button className={segment(value === false)} onClick={() => onChange(def.key, false)}>
                    Off
                  </button>
                </div>
              )}
              {def.type === 'select' && (
                <select
                  value={set ? String(value) : ''}
                  onChange={(e) => onChange(def.key, e.target.value === '' ? null : e.target.value)}
                  className="shrink-0 h-7 rounded-md bg-white/[0.04] border border-white/[0.08] px-2 text-[11.5px] text-zinc-200 outline-none"
                >
                  <option value="" className="bg-zinc-900">
                    Default
                  </option>
                  {mergeOptions(def.options, extra[def.key]).map((o) => (
                    <option key={o.id} value={o.id} className="bg-zinc-900">
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
              {def.type === 'text' && <TextSetting def={def} value={set ? String(value) : ''} onChange={onChange} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Commits on Enter or blur; empty means Default. */
function TextSetting({ def, value, onChange }: { def: SessionSettingDef; value: string; onChange: Props['onChange'] }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    const next = draft.trim()
    if (next !== value) onChange(def.key, next || null)
  }
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      placeholder={def.placeholder ? `Default · ${def.placeholder}` : 'Default'}
      className="shrink-0 w-36 h-7 rounded-md bg-white/[0.04] border border-white/[0.08] px-2 text-[11.5px] text-zinc-200 outline-none placeholder:text-zinc-600"
    />
  )
}

function mergeOptions(
  known: { id: string; label: string }[] = [],
  live: { id: string; label: string }[] = []
): { id: string; label: string }[] {
  const ids = new Set(known.map((o) => o.id))
  return [...known, ...live.filter((o) => !ids.has(o.id))]
}
