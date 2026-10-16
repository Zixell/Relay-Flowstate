import React, { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '../../lib/utils'

/** Assistant text: GitHub-flavored markdown in the app's dark palette. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('chat-markdown text-[13px] leading-relaxed text-zinc-200', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">
              {children}
            </a>
          ),
          code: ({ className: cls, children }) => {
            const block = /language-/.test(cls ?? '') || String(children).includes('\n')
            return block ? (
              <code className={cn('block font-mono text-[12px] text-zinc-200', cls)}>{children}</code>
            ) : (
              <code className="font-mono text-[12px] px-1 py-0.5 rounded bg-white/[0.07] text-zinc-100">{children}</code>
            )
          },
          pre: ({ children }) => (
            <pre className="my-2 p-3 rounded-lg bg-black/40 border border-white/[0.06] overflow-x-auto">{children}</pre>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
