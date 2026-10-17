import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Square, ImagePlus, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ChatCapabilities, SlashCommandInfo } from '../../types'

interface Props {
  inTurn: boolean
  capabilities?: ChatCapabilities
  model?: string | null
  mode?: string | null
  commands?: SlashCommandInfo[]
  onSend: (text: string, images: { mediaType: string; data: string }[]) => void
  onInterrupt: () => void
  onModeChange: (mode: string) => void
  onModelChange: (model: string) => void
}

interface Attachment {
  mediaType: string
  data: string
  preview: string
}

function readImage(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve({ mediaType: file.type, data: url.slice(url.indexOf(',') + 1), preview: url })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

const selectCls =
  'h-7 rounded-md bg-transparent text-[11.5px] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.05] px-1.5 outline-none cursor-pointer'

/**
 * Commands matching what was typed after `/`: prefix matches first, then the
 * rest. Plain commands come before plugin ones (`plugin:command`).
 */
export function matchCommands(commands: SlashCommandInfo[], query: string): SlashCommandInfo[] {
  const q = query.toLowerCase()
  const rank = (c: SlashCommandInfo): number => {
    const name = c.name.toLowerCase()
    const tail = name.slice(name.indexOf(':') + 1)
    const where = name.startsWith(q) ? 0 : tail.startsWith(q) ? 1 : name.includes(q) ? 2 : -1
    return where < 0 ? -1 : where * 2 + (name.includes(':') ? 1 : 0)
  }
  return commands
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r)
    .slice(0, 50)
    .map((x) => x.c)
}

export function Composer({ inTurn, capabilities, model, mode, commands = [], onSend, onInterrupt, onModeChange, onModelChange }: Props) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attachment[]>([])
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // The menu is open while only the command word is typed (`/rev`, no space yet).
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1]
  const matches = useMemo(() => (slashQuery != null ? matchCommands(commands, slashQuery) : []), [commands, slashQuery])
  const menuOpen = matches.length > 0 && !menuClosed
  useEffect(() => {
    setMenuIndex(0)
    setMenuClosed(false)
  }, [slashQuery])

  const pickCommand = (c: SlashCommandInfo): void => {
    setText(`/${c.name} `)
    setMenuClosed(true)
    requestAnimationFrame(() => {
      ref.current?.focus()
      resize()
    })
  }

  const resize = (): void => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }

  const submit = useCallback(() => {
    const value = text.trim()
    if (!value && images.length === 0) return
    onSend(value, images.map(({ mediaType, data }) => ({ mediaType, data })))
    setText('')
    setImages([])
    requestAnimationFrame(resize)
  }, [text, images, onSend])

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    const read = await Promise.all(imgs.map(readImage))
    setImages((prev) => [...prev, ...read])
  }

  const canSend = text.trim().length > 0 || images.length > 0

  return (
    <div className="relative rounded-2xl border border-white/[0.09] bg-[#111] focus-within:border-white/20 transition-colors">
      {menuOpen && (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-white/[0.09] bg-[#141414] shadow-2xl shadow-black/50 py-1 z-20 max-h-72 overflow-y-auto overflow-x-hidden">
          {matches.map((c, i) => (
            <button
              key={c.name}
              onMouseDown={(e) => {
                e.preventDefault()
                pickCommand(c)
              }}
              onMouseEnter={() => setMenuIndex(i)}
              className={cn('w-full flex items-baseline gap-2 px-3 py-1.5 text-left', i === menuIndex && 'bg-white/[0.06]')}
            >
              <span className="font-mono text-[12px] text-zinc-100 shrink-0">/{c.name}</span>
              {c.hint && <span className="font-mono text-[11px] text-zinc-600 truncate max-w-[35%] shrink-0">{c.hint}</span>}
              {c.description && <span className="text-[11.5px] text-zinc-500 truncate">{c.description}</span>}
            </button>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="flex gap-2 px-3 pt-3">
          {images.map((img, i) => (
            <div key={i} className="relative">
              <img src={img.preview} className="h-14 w-14 object-cover rounded-lg border border-white/10" />
              <button
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-800 border border-white/10 flex items-center justify-center"
              >
                <X className="w-2.5 h-2.5 text-zinc-300" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={ref}
        rows={1}
        value={text}
        placeholder={inTurn ? 'Queue a follow-up…' : commands.length ? 'Reply to the agent… (/ for commands)' : 'Reply to the agent…'}
        onChange={(e) => {
          setText(e.target.value)
          resize()
        }}
        onKeyDown={(e) => {
          if (menuOpen) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const step = e.key === 'ArrowDown' ? 1 : -1
              setMenuIndex((i) => (i + step + matches.length) % matches.length)
              return
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
              e.preventDefault()
              pickCommand(matches[menuIndex])
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setMenuClosed(true)
              return
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape' && inTurn) {
            e.preventDefault()
            onInterrupt()
          }
        }}
        onPaste={(e) => {
          if (capabilities?.images && e.clipboardData.files.length) {
            e.preventDefault()
            void addFiles(e.clipboardData.files)
          }
        }}
        className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[13px] text-zinc-100 placeholder:text-zinc-600 outline-none leading-relaxed"
      />

      <div className="flex items-center gap-1 px-2 pb-2">
        {capabilities?.images && (
          <>
            <button
              onClick={() => fileRef.current?.click()}
              title="Attach image"
              className="h-7 w-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05]"
            >
              <ImagePlus className="w-3.5 h-3.5" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </>
        )}
        {capabilities?.modes && (
          <select className={selectCls} value={mode ?? capabilities.modes[0].id} onChange={(e) => onModeChange(e.target.value)} title="Permission mode">
            {capabilities.modes.map((m) => (
              <option key={m.id} value={m.id} className="bg-zinc-900">
                {m.label}
              </option>
            ))}
          </select>
        )}
        {capabilities?.models && (
          <select className={selectCls} value={model ?? 'default'} onChange={(e) => onModelChange(e.target.value)} title="Model">
            {capabilities.models.map((m) => (
              <option key={m.id} value={m.id} className="bg-zinc-900">
                {m.label}
              </option>
            ))}
          </select>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {inTurn && (
            <button
              onClick={onInterrupt}
              title="Stop (Esc)"
              className="h-7 w-7 flex items-center justify-center rounded-full bg-white/[0.08] hover:bg-white/[0.14] text-zinc-200"
            >
              <Square className="w-3 h-3 fill-current" />
            </button>
          )}
          <button
            onClick={submit}
            disabled={!canSend}
            title="Send (Enter)"
            className={cn(
              'h-7 w-7 flex items-center justify-center rounded-full transition-colors',
              canSend ? 'bg-zinc-100 text-zinc-900 hover:bg-white' : 'bg-white/[0.06] text-zinc-600'
            )}
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
