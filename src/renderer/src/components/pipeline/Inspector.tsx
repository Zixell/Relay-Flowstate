import React, { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { AgentDescriptor } from '../../types'
import type { CompareOp, Condition, PipelineEdge, PipelineNode } from '../../../../main/pipeline/types'
import { VERDICT_SCHEMA, blockTitle } from './model'

const field = 'w-full rounded-md border border-white/[0.08] bg-black/30 px-2.5 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-white/25'

function Label({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-zinc-400">{children}</span>
      {hint && <span className="text-[10.5px] text-zinc-600 leading-snug">{hint}</span>}
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label hint={hint}>{label}</Label>
      {children}
    </div>
  )
}

function Select<T extends string>({ value, options, onChange }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} className={cn(field, 'py-1')}>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

const TEMPLATE_HINT = (
  <>
    Use <code className="text-zinc-400">{'{{input}}'}</code> for the user's message,{' '}
    <code className="text-zinc-400">{'{{block.output}}'}</code> or <code className="text-zinc-400">{'{{block.json.field}}'}</code> for what a
    block produced.
  </>
)

/** Edits text locally and commits on blur — ids must not change on every keystroke. */
function IdField({ id, valid, onRename }: { id: string; valid: (next: string) => string | null; onRename: (next: string) => void }) {
  const [draft, setDraft] = useState(id)
  useEffect(() => setDraft(id), [id])
  const problem = draft !== id ? valid(draft) : null
  return (
    <Row label="ID" hint={problem ?? 'Refers to the block in templates; renaming updates them.'}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => (problem || draft === id ? setDraft(id) : onRename(draft))}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className={cn(field, 'font-mono', problem && 'border-red-500/50')}
      />
    </Row>
  )
}

export function NodeInspector({
  node,
  agents,
  ids,
  onChange,
  onRename,
  onDelete
}: {
  node: PipelineNode
  agents: AgentDescriptor[]
  ids: string[]
  onChange: (next: PipelineNode) => void
  onRename: (next: string) => void
  onDelete: () => void
}) {
  const validId = (next: string): string | null => {
    if (!/^[A-Za-z][\w-]*$/.test(next)) return 'Letters, digits, - and _, starting with a letter'
    if (next === 'input') return '"input" is reserved for the user message'
    if (ids.includes(next)) return 'Another block has this id'
    return null
  }
  const set = (patch: Partial<PipelineNode>): void => onChange({ ...node, ...patch } as PipelineNode)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-zinc-100">{blockTitle(node)}</span>
        {node.type !== 'anchor' && (
          <button onClick={onDelete} title="Delete block" className="ml-auto p-1.5 rounded-md text-zinc-500 hover:text-red-300 hover:bg-red-500/10">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <Row label="Name">
        <input value={node.label ?? ''} placeholder={blockTitle({ ...node, label: undefined })} onChange={(e) => set({ label: e.target.value || undefined })} className={field} />
      </Row>
      <IdField id={node.id} valid={validId} onRename={onRename} />

      {node.type === 'anchor' && (
        <Row label="Prompt sent to the chat agent" hint={<>Empty sends the message as typed. {TEMPLATE_HINT} The chat shows what the user typed.</>}>
          <textarea rows={4} value={node.prompt ?? ''} placeholder="{{input}}" onChange={(e) => set({ prompt: e.target.value || undefined })} className={cn(field, 'resize-y font-mono')} />
        </Row>
      )}

      {(node.type === 'agent' || node.type === 'prompt') && (
        <Row label={node.type === 'prompt' ? 'Message sent to the chat agent' : 'Prompt'} hint={TEMPLATE_HINT}>
          <textarea rows={6} value={node.prompt} onChange={(e) => set({ prompt: e.target.value })} className={cn(field, 'resize-y font-mono')} />
        </Row>
      )}

      {node.type === 'agent' && (
        <>
          <Row label="Session" hint={node.session === 'new' ? 'A fresh agent in the same worktree — e.g. an independent reviewer. Its work shows only in the run.' : 'The chat\'s own agent, with everything said so far.'}>
            <Select
              value={node.session}
              options={[
                { id: 'new', label: 'New session' },
                { id: 'current', label: 'Current chat session' }
              ]}
              onChange={(session) => onChange({ ...node, session, agent: session === 'current' ? undefined : node.agent })}
            />
          </Row>
          {node.session === 'new' && (
            <Row label="Agent">
              <Select
                value={node.agent ?? ''}
                options={[{ id: '', label: "The task's agent" }, ...agents.filter((a) => a.enabled && a.chat).map((a) => ({ id: a.id, label: a.label }))]}
                onChange={(agent) => onChange({ ...node, agent: agent || undefined })}
              />
            </Row>
          )}
          <OutputSchema node={node} onChange={onChange} />
        </>
      )}

      {node.type === 'action' && node.action === 'commit' && (
        <Row label="Commit message" hint="Commits every change in the worktree. Templates work here.">
          <input value={node.message ?? ''} placeholder="Pipeline commit" onChange={(e) => onChange({ ...node, message: e.target.value })} className={field} />
        </Row>
      )}
      {node.type === 'action' && node.action === 'shell' && (
        <Row
          label="Command"
          hint={
            <>
              Runs in the worktree. Earlier results come as environment variables, never pasted into the command:{' '}
              <code className="text-zinc-400">$PIPELINE_INPUT</code>, <code className="text-zinc-400">$PIPELINE_REVIEW_OUTPUT</code>,{' '}
              <code className="text-zinc-400">_JSON</code>, <code className="text-zinc-400">_STATUS</code>. A non-zero exit fails the block.
            </>
          }
        >
          <textarea rows={3} value={node.command} onChange={(e) => onChange({ ...node, command: e.target.value })} className={cn(field, 'resize-y font-mono')} />
        </Row>
      )}
      {node.type === 'action' && node.action === 'notify' && (
        <Row label="Notification text" hint={TEMPLATE_HINT}>
          <input value={node.message} onChange={(e) => onChange({ ...node, message: e.target.value })} className={field} />
        </Row>
      )}
      {node.type === 'join' && <p className="text-[11.5px] text-zinc-500 leading-relaxed">Goes on once every parallel branch that can still reach it has arrived.</p>}
    </div>
  )
}

function OutputSchema({ node, onChange }: { node: Extract<PipelineNode, { type: 'agent' }>; onChange: (n: PipelineNode) => void }) {
  const mode = !node.outputSchema ? 'none' : JSON.stringify(node.outputSchema) === JSON.stringify(VERDICT_SCHEMA) ? 'verdict' : 'custom'
  const [text, setText] = useState(() => JSON.stringify(node.outputSchema ?? VERDICT_SCHEMA, null, 2))
  const [bad, setBad] = useState(false)
  useEffect(() => {
    if (mode !== 'custom') setText(JSON.stringify(node.outputSchema ?? VERDICT_SCHEMA, null, 2))
  }, [mode, node.outputSchema])

  return (
    <>
      <Row
        label="Structured answer"
        hint={mode === 'none' ? 'Free text. Arrows can still check the step result or changed files.' : 'The agent ends its answer with JSON; arrows can check its fields, e.g. verdict = pass.'}
      >
        <Select
          value={mode}
          options={[
            { id: 'none', label: 'None' },
            { id: 'verdict', label: 'Verdict: pass / fail + issues' },
            { id: 'custom', label: 'Custom JSON schema' }
          ]}
          onChange={(m) => {
            if (m === 'none') onChange({ ...node, outputSchema: undefined })
            else if (m === 'verdict') onChange({ ...node, outputSchema: VERDICT_SCHEMA })
            else onChange({ ...node, outputSchema: { type: 'object', properties: {} } })
          }}
        />
      </Row>
      {mode === 'custom' && (
        <textarea
          rows={8}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            try {
              const parsed = JSON.parse(e.target.value)
              setBad(false)
              onChange({ ...node, outputSchema: parsed })
            } catch {
              setBad(true)
            }
          }}
          className={cn(field, 'resize-y font-mono text-[11px]', bad && 'border-red-500/50')}
        />
      )}
    </>
  )
}

type When = 'always' | 'if' | 'else'
type CheckKind = 'output' | 'status' | 'filesChanged'

const OP_OPTIONS: { id: CompareOp; label: string }[] = [
  { id: 'eq', label: 'equals' },
  { id: 'neq', label: 'does not equal' },
  { id: 'contains', label: 'contains' },
  { id: 'matches', label: 'matches regex' },
  { id: 'gt', label: 'greater than' },
  { id: 'lt', label: 'less than' },
  { id: 'exists', label: 'is present' }
]

export function EdgeInspector({
  edge,
  isLoop,
  nodes,
  onChange,
  onDelete
}: {
  edge: PipelineEdge
  isLoop: boolean
  nodes: PipelineNode[]
  onChange: (next: PipelineEdge) => void
  onDelete: () => void
}) {
  const when: When = edge.isDefault ? 'else' : edge.condition ? 'if' : 'always'
  const c = edge.condition
  const name = (id: string): string => {
    const n = nodes.find((x) => x.id === id)
    return n ? blockTitle(n) : id
  }

  const setWhen = (next: When): void => {
    const { condition: _c, isDefault: _d, order: _o, ...rest } = edge
    if (next === 'always') onChange(rest)
    else if (next === 'else') onChange({ ...rest, isDefault: true })
    else onChange({ ...rest, condition: c ?? { kind: 'output', path: 'json.verdict', op: 'eq', value: 'pass' } })
  }
  const setCheck = (kind: CheckKind): void => {
    const next: Condition =
      kind === 'status' ? { kind: 'status', equals: 'error' } : kind === 'filesChanged' ? { kind: 'filesChanged' } : { kind: 'output', path: 'json.verdict', op: 'eq', value: 'pass' }
    onChange({ ...edge, condition: next })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-zinc-100 truncate">
          {name(edge.from)} → {name(edge.to)}
        </span>
        <button onClick={onDelete} title="Delete arrow" className="ml-auto p-1.5 rounded-md text-zinc-500 hover:text-red-300 hover:bg-red-500/10">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <Row
        label="Follow this arrow"
        hint="Plain arrows always fire — several of them run in parallel. Of the conditional ones the first match (by order) fires, else the default."
      >
        <Select
          value={when}
          options={[
            { id: 'always', label: 'Always' },
            { id: 'if', label: 'If a condition holds' },
            { id: 'else', label: 'Otherwise (default)' }
          ]}
          onChange={setWhen}
        />
      </Row>

      {c && when === 'if' && (
        <>
          {c.kind === 'all' || c.kind === 'any' || c.kind === 'not' ? (
            <p className="text-[11.5px] text-zinc-500">This combined condition can only be changed in the pipeline JSON for now.</p>
          ) : (
            <Row label="Check">
              <Select
                value={c.kind}
                options={[
                  { id: 'output', label: 'A field of the answer' },
                  { id: 'status', label: 'Whether the block succeeded' },
                  { id: 'filesChanged', label: 'Whether files changed' }
                ]}
                onChange={setCheck}
              />
            </Row>
          )}
          {c.kind === 'output' && (
            <>
              <Row label="Field" hint={<><code className="text-zinc-400">json.verdict</code> for a structured answer, <code className="text-zinc-400">output</code> for the text, <code className="text-zinc-400">exitCode</code> for a command.</>}>
                <input value={c.path} onChange={(e) => onChange({ ...edge, condition: { ...c, path: e.target.value } })} className={cn(field, 'font-mono')} />
              </Row>
              <div className="grid grid-cols-2 gap-2">
                <Select value={c.op} options={OP_OPTIONS} onChange={(op) => onChange({ ...edge, condition: { ...c, op } })} />
                {c.op !== 'exists' && (
                  <input value={String(c.value ?? '')} onChange={(e) => onChange({ ...edge, condition: { ...c, value: e.target.value } })} className={field} placeholder="value" />
                )}
              </div>
            </>
          )}
          {c.kind === 'status' && (
            <Select
              value={c.equals}
              options={[
                { id: 'ok', label: 'Succeeded' },
                { id: 'error', label: 'Failed' }
              ]}
              onChange={(equals) => onChange({ ...edge, condition: { kind: 'status', equals } })}
            />
          )}
          {c.kind === 'filesChanged' && (
            <Row label="Only these files (optional)" hint="A glob such as src/**/*.ts; empty means any file.">
              <input value={c.glob ?? ''} onChange={(e) => onChange({ ...edge, condition: { kind: 'filesChanged', glob: e.target.value || undefined } })} className={cn(field, 'font-mono')} />
            </Row>
          )}
          <Row label="Order" hint="Checked from the lowest number up.">
            <input
              type="number"
              min={1}
              value={edge.order ?? ''}
              onChange={(e) => onChange({ ...edge, order: e.target.value ? Number(e.target.value) : undefined })}
              className={cn(field, 'w-24')}
            />
          </Row>
        </>
      )}

      {isLoop && (
        <div className="flex flex-col gap-3 rounded-lg border border-violet-500/20 bg-violet-500/[0.04] p-3">
          <Label hint="This arrow goes back and closes a loop. Each loop needs a limit so the pipeline always ends.">Loop</Label>
          <Row label="Maximum rounds">
            <input
              type="number"
              min={1}
              value={edge.maxIterations ?? ''}
              onChange={(e) => onChange({ ...edge, maxIterations: e.target.value ? Math.max(1, Math.floor(Number(e.target.value))) : undefined })}
              className={cn(field, 'w-24', !edge.maxIterations && 'border-red-500/50')}
            />
          </Row>
          <Row label="After the last round">
            <Select
              value={edge.onExhausted?.kind === 'goto' ? edge.onExhausted.nodeId : ''}
              options={[
                { id: '', label: 'Fail the run' },
                ...nodes.filter((n) => n.type !== 'join' && n.type !== 'anchor').map((n) => ({ id: n.id, label: `Go to ${blockTitle(n)}` }))
              ]}
              onChange={(target) => onChange({ ...edge, onExhausted: target ? { kind: 'goto', nodeId: target } : undefined })}
            />
          </Row>
        </div>
      )}
    </div>
  )
}
