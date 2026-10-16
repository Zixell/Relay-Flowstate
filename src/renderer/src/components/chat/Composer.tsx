import React, { useCallback, useRef, useState } from 'react'
import { ArrowUp, Square, ImagePlus, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ChatCapabilities } from '../../types'

interface Props {
  inTurn: boolean
  capabilities?: ChatCapabilities
  model?: string | null
  mode?: string | null
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

export function Composer({ inTurn, capabilities, model, mode, onSend, onInterrupt, onModeChange, onModelChange }: Props) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attachment[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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
    <div className="rounded-2xl border border-white/[0.09] bg-[#111] focus-within:border-white/20 transition-colors">
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
        placeholder={inTurn ? 'Queue a follow-up…' : 'Reply to the agent…'}
        onChange={(e) => {
          setText(e.target.value)
          resize()
        }}
        onKeyDown={(e) => {
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
