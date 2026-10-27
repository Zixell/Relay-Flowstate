import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Square, ImagePlus, X, SlidersHorizontal, PictureInPicture2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ChatCapabilities, SlashCommandInfo } from '../../types'
import { SessionSettings } from './SessionSettings'

interface Props {
  inTurn: boolean
  capabilities?: ChatCapabilities
  model?: string | null
  mode?: string | null
  commands?: SlashCommandInfo[]
  /** Task whose worktree `@` mentions complete against. */
  taskId?: string
  /** The agent's predicted next message, shown as ghost text; Tab accepts it. */
  suggestion?: string | null
  onSend: (text: string, images: { mediaType: string; data: string }[]) => void
  onInterrupt: () => void
  onModeChange: (mode: string) => void
  onModelChange: (model: string) => void
  /** The task's session settings (the chat's /config); absent keys follow the agent's own config. */
  sessionSettings?: Record<string, string | boolean>
  onSessionSetting?: (key: string, value: string | boolean | null) => void
  /** Opens the chat in a floating window; absent inside one. */
  onFloat?: () => void
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

/** Shared by the textarea and the ghost-text overlay so both lay text out identically. */
const TEXT_BOX = 'px-4 pt-3 pb-1 text-[13px] leading-relaxed'

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

interface MenuItem {
  key: string
  label: string
  hint?: string
  description?: string
  pick: () => void
}

/** An `@mention` being typed right before the caret: its query and where it starts. */
export function mentionAt(text: string, caret: number): { query: string; start: number } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  return m ? { query: m[2], start: caret - m[2].length - 1 } : null
}

export function Composer({
  inTurn,
  capabilities,
  model,
  mode,
  commands = [],
  taskId,
  suggestion,
  onSend,
  onInterrupt,
  onModeChange,
  onModelChange,
  sessionSettings = {},
  onSessionSetting,
  onFloat
}: Props) {
  const [text, setText] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingDefs = onSessionSetting && taskId ? capabilities?.sessionSettings : undefined
  const [caret, setCaret] = useState(0)
  const [images, setImages] = useState<Attachment[]>([])
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const setValue = (value: string, cursor = value.length): void => {
    setText(value)
    setCaret(cursor)
    setMenuClosed(true)
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.setSelectionRange(cursor, cursor)
      resize()
    })
  }

  // `/command` while only the command word is typed; `@path` anywhere before the caret.
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1]
  const mention = slashQuery == null && taskId ? mentionAt(text, caret) : null

  useEffect(() => {
    if (!mention || !window.api?.chat?.suggestFiles) {
      setFiles([])
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      window.api.chat.suggestFiles(taskId!, mention.query).then((list) => alive && setFiles(list))
    }, 60)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [mention?.query, mention?.start, taskId]) // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo<MenuItem[]>(() => {
    if (slashQuery != null) {
      return matchCommands(commands, slashQuery).map((c) => ({
        key: c.name,
        label: `/${c.name}`,
        hint: c.hint,
        description: c.description,
        pick: () => setValue(`/${c.name} `)
      }))
    }
    if (mention) {
      return files.map((f) => {
        const slash = f.lastIndexOf('/')
        return {
          key: f,
          label: f.slice(slash + 1),
          description: slash > 0 ? f.slice(0, slash) : undefined,
          pick: () => {
            const insert = `@${f} `
            setValue(text.slice(0, mention.start) + insert + text.slice(caret), mention.start + insert.length)
          }
        }
      })
    }
    return []
  }, [slashQuery, commands, mention?.start, mention?.query, files, text, caret]) // eslint-disable-line react-hooks/exhaustive-deps

  const menuOpen = items.length > 0 && !menuClosed
  useEffect(() => {
    setMenuIndex(0)
    setMenuClosed(false)
  }, [slashQuery, mention?.query, mention?.start])

  // Ghost text: the rest of the agent's suggestion, while what is typed matches its start.
  const ghost =
    suggestion && !menuOpen && !images.length && caret === text.length && suggestion.length > text.length && suggestion.startsWith(text)
      ? suggestion.slice(text.length)
      : null

  const resize = (): void => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }

  const submit = useCallback(() => {
    const value = text.trim()
    if (!value && images.length === 0) return
    // `/config` on its own opens the settings panel, as it does in the CLI; with arguments it goes to the agent
    if (value === '/config' && settingDefs?.length) {
      setText('')
      setCaret(0)
      setSettingsOpen(true)
      return
    }
    onSend(value, images.map(({ mediaType, data }) => ({ mediaType, data })))
    setText('')
    setCaret(0)
    setImages([])
    requestAnimationFrame(resize)
  }, [text, images, onSend, settingDefs])

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    const read = await Promise.all(imgs.map(readImage))
    setImages((prev) => [...prev, ...read])
  }

  const canSend = text.trim().length > 0 || images.length > 0

  return (
    <div className="relative rounded-2xl border border-white/[0.09] bg-[#111] focus-within:border-white/20 transition-colors">
      {settingsOpen && settingDefs && (
        <SessionSettings
          taskId={taskId!}
          defs={settingDefs}
          values={sessionSettings}
          onChange={onSessionSetting!}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {menuOpen && (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-white/[0.09] bg-[#141414] shadow-2xl shadow-black/50 py-1 z-20 max-h-72 overflow-y-auto overflow-x-hidden">
          {items.map((item, i) => (
            <button
              key={item.key}
              onMouseDown={(e) => {
                e.preventDefault()
                item.pick()
              }}
              onMouseEnter={() => setMenuIndex(i)}
              className={cn('w-full flex items-baseline gap-2 px-3 py-1.5 text-left', i === menuIndex && 'bg-white/[0.06]')}
            >
              <span className="font-mono text-[12px] text-zinc-100 shrink-0">{item.label}</span>
              {item.hint && <span className="font-mono text-[11px] text-zinc-600 truncate max-w-[35%] shrink-0">{item.hint}</span>}
              {item.description && <span className="text-[11.5px] text-zinc-500 truncate">{item.description}</span>}
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

      <div className="relative">
        {ghost && (
          // Mirrors the textarea's text box so the ghost continues right after the caret.
          <div aria-hidden className={cn(TEXT_BOX, 'absolute inset-0 pointer-events-none whitespace-pre-wrap break-words overflow-hidden')}>
            <span className="invisible">{text}</span>
            <span className="text-zinc-600">{ghost}</span>
            <kbd className="ml-2 align-middle text-[10px] font-sans text-zinc-600 border border-white/10 rounded px-1 py-px">Tab</kbd>
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={
            ghost != null ? '' : inTurn ? 'Queue a follow-up…' : taskId ? 'Reply to the agent… (/ commands, @ files)' : 'Reply to the agent…'
          }
          onChange={(e) => {
            setText(e.target.value)
            setCaret(e.target.selectionStart)
            resize()
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const step = e.key === 'ArrowDown' ? 1 : -1
                setMenuIndex((i) => (i + step + items.length) % items.length)
                return
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
                e.preventDefault()
                items[menuIndex].pick()
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMenuClosed(true)
                return
              }
            }
            // Tab, or → at the end of the text, takes the suggestion.
            if (ghost && suggestion && (e.key === 'Tab' || (e.key === 'ArrowRight' && !e.shiftKey)) && !e.nativeEvent.isComposing) {
              e.preventDefault()
              setValue(suggestion)
              return
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
          className={cn(TEXT_BOX, 'relative w-full resize-none bg-transparent text-zinc-100 placeholder:text-zinc-600 outline-none')}
        />
      </div>

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
        {settingDefs?.length ? (
          <button
            onClick={() => setSettingsOpen((o) => !o)}
            title="Session settings (/config)"
            className={cn(
              'h-7 flex items-center gap-1.5 px-2 rounded-md text-[12px] hover:bg-white/[0.05]',
              Object.keys(sessionSettings).length ? 'text-zinc-200' : 'text-zinc-500 hover:text-zinc-200'
            )}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {Object.keys(sessionSettings).length > 0 && <span className="text-[10.5px]">{Object.keys(sessionSettings).length}</span>}
          </button>
        ) : null}
        {onFloat && (
          <button
            onClick={onFloat}
            title="Float this chat above other windows"
            className="h-7 w-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.05]"
          >
            <PictureInPicture2 className="w-3.5 h-3.5" />
          </button>
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
