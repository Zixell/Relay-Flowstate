import React, { memo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'
import { cn } from '../../lib/utils'

interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

function hastText(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

function CodeBlock({ node, children }: { node?: HastNode; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false)
  const code = node?.children?.find((c) => c.tagName === 'code')
  const classes = Array.isArray(code?.properties?.className) ? (code!.properties!.className as string[]) : []
  const language = classes.find((c) => c.startsWith('language-'))?.slice('language-'.length)

  const copy = (): void => {
    void navigator.clipboard.writeText(hastText(code).replace(/\n$/, ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="group relative my-2 rounded-lg bg-black/40 border border-white/[0.06]">
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {language && <span className="text-[10px] text-zinc-600 font-mono">{language}</span>}
        <button onClick={copy} title="Copy" className="h-6 w-6 flex items-center justify-center rounded-md bg-zinc-900/90 border border-white/[0.06] text-zinc-400 hover:text-zinc-100">
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto">{children}</pre>
    </div>
  )
}

/** Assistant text: GitHub-flavored markdown in the app's dark palette. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('chat-markdown text-[13px] leading-relaxed text-zinc-200', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
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
          pre: ({ node, children }) => <CodeBlock node={node as HastNode | undefined}>{children}</CodeBlock>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
