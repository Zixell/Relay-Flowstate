import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Workflow, ChevronRight, Loader2, Check, X, Ban, Square } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ChatMessage } from '../../types'
import type { PipelineGraph, PipelineRunRow, RunEvent, RunStatus, StepOutput } from '../../../../main/pipeline/types'

interface StepView {
  id: string
  nodeId: string
  activation: number
  status: 'running' | 'ok' | 'error' | 'cancelled'
  output?: StepOutput
}

interface RunView {
  status: RunStatus
  error: string | null
  graph: PipelineGraph | null
  steps: StepView[]
}

function apply(view: RunView, e: RunEvent): RunView {
  switch (e.type) {
    case 'step.started':
      if (view.steps.some((s) => s.id === e.stepId)) return view
      return { ...view, steps: [...view.steps, { id: e.stepId, nodeId: e.nodeId, activation: e.activation, status: 'running' }] }
    case 'step.completed':
      return { ...view, steps: view.steps.map((s) => (s.id === e.stepId ? { ...s, status: e.output.status, output: e.output } : s)) }
    case 'run.completed':
      return {
        ...view,
        status: e.status,
        error: e.error ?? null,
        // Steps the run stopped before they finished
        steps: view.steps.map((s) => (s.status === 'running' ? { ...s, status: 'cancelled' } : s))
      }
    default:
      return view
  }
}

const RUN_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted by app restart'
}

function StatusIcon({ status }: { status: StepView['status'] | RunStatus }) {
  if (status === 'running') return <Loader2 className="w-3 h-3 animate-spin text-zinc-500" />
  if (status === 'ok' || status === 'completed') return <Check className="w-3 h-3 text-emerald-500/80" />
  if (status === 'error' || status === 'failed') return <X className="w-3 h-3 text-red-400" />
  return <Ban className="w-3 h-3 text-zinc-500" />
}

/** A pipeline run in the chat: its steps with live statuses; a step opens to its output. */
export function PipelineRunCard({ message }: { message: ChatMessage }) {
  const { runId, name } = useMemo<{ runId?: string; name?: string }>(() => {
    try {
      return JSON.parse(message.content ?? '{}')
    } catch {
      return {}
    }
  }, [message.content])
  const [view, setView] = useState<RunView | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const early = useRef<RunEvent[] | null>([])

  useEffect(() => {
    if (!runId) return
    let cancelled = false
    early.current = []
    // Subscribe first so nothing that happens during the load is lost
    const unsub = window.api.pipelines.onEvent(message.task_id, (e) => {
      if (e.runId !== runId) return
      if (early.current) early.current.push(e)
      else setView((v) => (v ? apply(v, e) : v))
    })
    window.api.pipelines.run(runId).then((res) => {
      if (cancelled || !res) return
      let v: RunView = {
        status: res.run.status,
        error: res.run.error,
        graph: parseGraph(res.run),
        steps: res.steps.map((s) => ({
          id: s.id,
          nodeId: s.node_id,
          activation: s.activation,
          status: s.status,
          output: s.output_json ? (JSON.parse(s.output_json) as StepOutput) : undefined
        }))
      }
      for (const e of early.current ?? []) v = apply(v, e)
      early.current = null
      setView(v)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [runId, message.task_id])

  const label = (nodeId: string): string => {
    const node = view?.graph?.nodes.find((n) => n.id === nodeId)
    if (node?.label) return node.label
    return node?.type === 'anchor' ? 'Input prompt' : nodeId
  }

  const status = view?.status ?? 'running'
  return (
    <div className="rounded-lg border border-violet-500/15 bg-violet-500/[0.03] overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
        <Workflow className="w-3.5 h-3.5 text-violet-300/80 shrink-0" />
        <span className="text-zinc-300 truncate">Pipeline{name ? ` · ${name}` : ''}</span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0 text-zinc-500">
          <StatusIcon status={status} />
          {RUN_LABEL[status]}
        </span>
        {status === 'running' && (
          <button
            onClick={() => window.api.pipelines.cancel(message.task_id)}
            title="Stop the pipeline"
            className="shrink-0 flex items-center gap-1 h-6 px-2 rounded-md text-[11px] text-zinc-400 border border-white/[0.08] hover:text-zinc-200 hover:bg-white/[0.05]"
          >
            <Square className="w-2.5 h-2.5" />
            Stop
          </button>
        )}
      </div>

      {view && view.steps.length > 0 && (
        <div className="border-t border-white/[0.05]">
          {view.steps.map((s) => {
            const out = s.output
            const summary = out?.error ?? firstLine(out?.output)
            const expandable = Boolean(out && (out.output || out.error || out.json !== undefined || out.changedFiles?.length))
            return (
              <div key={s.id}>
                <button
                  onClick={() => expandable && setOpen((o) => (o === s.id ? null : s.id))}
                  className={cn(
                    'w-full flex items-center gap-2 px-3 py-1 text-left text-[12px]',
                    expandable ? 'hover:bg-white/[0.03] cursor-pointer' : 'cursor-default'
                  )}
                >
                  <ChevronRight className={cn('w-3 h-3 text-zinc-600 transition-transform shrink-0', open === s.id && 'rotate-90', !expandable && 'opacity-0')} />
                  <StatusIcon status={s.status} />
                  <span className="text-zinc-300 shrink-0">{label(s.nodeId)}</span>
                  {s.activation > 0 && <span className="text-zinc-600 shrink-0">round {s.activation + 1}</span>}
                  {summary && <span className={cn('truncate', s.status === 'error' ? 'text-red-300/80' : 'text-zinc-500')}>{summary}</span>}
                </button>
                {open === s.id && out && <StepDetails output={out} />}
              </div>
            )
          })}
        </div>
      )}

      {view?.error && (
        <div className="border-t border-white/[0.05] px-3 py-1.5 text-[12px] text-red-300/90 whitespace-pre-wrap break-words">{view.error}</div>
      )}
    </div>
  )
}

function StepDetails({ output }: { output: StepOutput }) {
  return (
    <div className="mx-3 mb-2 rounded-md border border-white/[0.05] bg-black/30 text-[11.5px]">
      {output.error && <div className="px-3 py-1.5 text-red-300/90 border-b border-white/[0.04]">{output.error}</div>}
      {output.changedFiles && output.changedFiles.length > 0 && (
        <div className="px-3 py-1.5 text-zinc-500 border-b border-white/[0.04] font-mono">
          {output.changedFiles.map((f) => (
            <div key={f} className="truncate">
              {f}
            </div>
          ))}
        </div>
      )}
      {output.output && (
        <pre className="px-3 py-2 max-h-72 overflow-auto font-mono text-zinc-300 whitespace-pre-wrap break-words selectable">{output.output}</pre>
      )}
      {output.json !== undefined && !output.output.includes('```json') && (
        <pre className="px-3 py-2 max-h-48 overflow-auto font-mono text-zinc-400 whitespace-pre-wrap break-words border-t border-white/[0.04] selectable">
          {JSON.stringify(output.json, null, 2)}
        </pre>
      )}
    </div>
  )
}

function firstLine(text?: string): string {
  return text?.trim().split('\n')[0]?.slice(0, 160) ?? ''
}

function parseGraph(run: PipelineRunRow): PipelineGraph | null {
  try {
    return JSON.parse(run.graph_json) as PipelineGraph
  } catch {
    return null
  }
}
