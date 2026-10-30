import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Workflow, Check, X, Loader2, Minus, Square, Maximize2 } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { cn } from '../../lib/utils'
import type { PipelineGraph, PipelineRunRow, PipelineStepRow, RunEvent, RunStatus, StepOutput } from '../../../../main/pipeline/types'

export interface StepView {
  id: string
  nodeId: string
  activation: number
  status: 'running' | 'ok' | 'error' | 'cancelled'
  output?: StepOutput
  /** Seconds since epoch; what puts parallel steps into one column. */
  startedAt: number
  endedAt?: number
}

export interface RunView {
  id: string
  name: string
  /** The user message the run started from. */
  input: string
  status: RunStatus
  error: string | null
  graph: PipelineGraph | null
  steps: StepView[]
}

const now = (): number => Date.now() / 1000

export function fromRows(run: PipelineRunRow, steps: PipelineStepRow[]): RunView {
  let graph: (PipelineGraph & { name?: string }) | null = null
  try {
    graph = JSON.parse(run.graph_json)
  } catch {
    // shown without labels
  }
  const name = graph?.name ?? 'Pipeline'
  return {
    id: run.id,
    name,
    input: run.input,
    status: run.status,
    error: run.error,
    graph,
    steps: steps.map((s) => ({
      id: s.id,
      nodeId: s.node_id,
      activation: s.activation,
      status: s.status,
      output: s.output_json ? (JSON.parse(s.output_json) as StepOutput) : undefined,
      startedAt: s.started_at,
      endedAt: s.completed_at ?? undefined
    }))
  }
}

export function apply(view: RunView, e: RunEvent): RunView {
  if (e.runId !== view.id) return view
  switch (e.type) {
    case 'step.started':
      if (view.steps.some((s) => s.id === e.stepId)) return view
      return { ...view, steps: [...view.steps, { id: e.stepId, nodeId: e.nodeId, activation: e.activation, status: 'running', startedAt: now() }] }
    case 'step.completed':
      return {
        ...view,
        steps: view.steps.map((s) => (s.id === e.stepId ? { ...s, status: e.output.status, output: e.output, endedAt: now() } : s))
      }
    case 'run.completed':
      return {
        ...view,
        status: e.status,
        error: e.error ?? null,
        steps: view.steps.map((s) => (s.status === 'running' ? { ...s, status: 'cancelled', endedAt: now() } : s))
      }
    default:
      return view
  }
}

/** Steps that overlapped in time share a column, like parallel jobs of a CI stage. */
export function columns<T extends { startedAt: number; endedAt?: number }>(steps: T[]): T[][] {
  const cols: T[][] = []
  for (const s of steps) {
    const last = cols[cols.length - 1]
    if (last && last.some((x) => (x.endedAt ?? Infinity) > s.startedAt)) last.push(s)
    else cols.push([s])
  }
  return cols
}

const RUN_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  completed: 'Passed',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted'
}

function Dot({ status, active, onClick, title }: { status: StepView['status']; active: boolean; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'relative w-5 h-5 rounded-full flex items-center justify-center border transition-shadow',
        status === 'ok' && 'border-emerald-500/70 bg-emerald-500/15 text-emerald-400',
        status === 'error' && 'border-red-500/70 bg-red-500/15 text-red-400',
        status === 'running' && 'border-blue-400/70 bg-blue-500/10 text-blue-300',
        status === 'cancelled' && 'border-zinc-600 bg-zinc-700/20 text-zinc-500',
        active && 'ring-2 ring-white/40'
      )}
    >
      {status === 'ok' && <Check className="w-3 h-3" strokeWidth={3} />}
      {status === 'error' && <X className="w-3 h-3" strokeWidth={3} />}
      {status === 'running' && <Loader2 className="w-3 h-3 animate-spin" strokeWidth={3} />}
      {status === 'cancelled' && <Minus className="w-3 h-3" strokeWidth={3} />}
    </button>
  )
}

/**
 * The task's latest pipeline run as a CI-style strip: a dot per step, parallel
 * steps stacked. A dot opens the step's output. Lives in the chat's top-right corner.
 */
export function PipelineProgress({ taskId }: { taskId: string }) {
  const focusPipelineRun = useAppStore((s) => s.focusPipelineRun)
  const [view, setView] = useState<RunView | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [hidden, setHidden] = useState<string | null>(null)
  const early = useRef<RunEvent[] | null>([])

  useEffect(() => {
    let cancelled = false
    early.current = []
    setView(null)
    const load = (runId?: string): void => {
      const req = runId ? window.api.pipelines.run(runId) : window.api.pipelines.latest(taskId)
      void req.then((res) => {
        if (cancelled || !res) return
        let v = fromRows(res.run, res.steps)
        for (const e of early.current ?? []) v = apply(v, e)
        early.current = null
        setView(v)
        setOpen(null)
      })
    }
    const unsub = window.api.pipelines.onEvent(taskId, (e) => {
      if (e.type === 'run.started') {
        // A new run takes the strip over
        early.current = []
        load(e.runId)
        return
      }
      if (early.current) early.current.push(e)
      else setView((v) => (v ? apply(v, e) : v))
    })
    load()
    return () => {
      cancelled = true
      unsub()
    }
  }, [taskId])

  const label = (nodeId: string): string => {
    const node = view?.graph?.nodes.find((n) => n.id === nodeId)
    if (node?.label) return node.label
    return node?.type === 'anchor' ? 'Input prompt' : nodeId
  }
  const cols = useMemo(() => columns(view?.steps ?? []), [view?.steps])
  const spent = useMemo(() => (view ? usage(view) : null), [view])
  const opened = view?.steps.find((s) => s.id === open)

  if (!view || hidden === view.id) return null
  const done = view.status !== 'running'

  return (
    <div className="w-[300px] rounded-xl border border-white/[0.08] bg-[#111]/95 backdrop-blur shadow-xl text-[12px] select-none">
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <Workflow className="w-3.5 h-3.5 text-violet-300/80 shrink-0" />
        <span className="text-zinc-300 truncate">{view.name}</span>
        <span
          className={cn(
            'ml-auto shrink-0 text-[11px]',
            view.status === 'completed' && 'text-emerald-400',
            view.status === 'failed' && 'text-red-400',
            view.status === 'running' && 'text-blue-300',
            (view.status === 'cancelled' || view.status === 'interrupted') && 'text-zinc-500'
          )}
        >
          {RUN_LABEL[view.status]}
        </span>
        <button
          onClick={() => focusPipelineRun({ taskId, runId: view.id })}
          title="Open the run on the pipeline graph"
          className="p-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06]"
        >
          <Maximize2 className="w-3 h-3" />
        </button>
        {!done ? (
          <button onClick={() => window.api.pipelines.cancel(taskId)} title="Stop the pipeline" className="p-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06]">
            <Square className="w-3 h-3" />
          </button>
        ) : (
          <button onClick={() => setHidden(view.id)} title="Hide until the next run" className="p-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06]">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {spent && <div className="px-3 pt-1 text-[10.5px] text-zinc-500">{spent}</div>}

      <div className="flex items-center px-3 py-3 overflow-x-auto">
        {cols.map((col, i) => (
          <React.Fragment key={col[0].id}>
            {i > 0 && <div className="w-4 h-px bg-white/15 shrink-0" />}
            <div className="flex flex-col gap-1.5 shrink-0">
              {col.map((s) => (
                <Dot
                  key={s.id}
                  status={s.status}
                  active={open === s.id}
                  title={`${label(s.nodeId)}${s.activation > 0 ? ` · round ${s.activation + 1}` : ''}`}
                  onClick={() => setOpen((o) => (o === s.id ? null : s.id))}
                />
              ))}
            </div>
          </React.Fragment>
        ))}
        {!cols.length && <span className="text-zinc-600">Starting…</span>}
      </div>

      {opened && (
        <div className="border-t border-white/[0.06] px-3 py-2 flex flex-col gap-1.5 select-text">
          <div className="flex items-center gap-2">
            <span className="text-zinc-200">{label(opened.nodeId)}</span>
            {opened.activation > 0 && <span className="text-zinc-600">round {opened.activation + 1}</span>}
          </div>
          {opened.output?.error && <div className="text-red-300/90 whitespace-pre-wrap break-words">{opened.output.error}</div>}
          {opened.output?.changedFiles && opened.output.changedFiles.length > 0 && (
            <div className="font-mono text-[11px] text-zinc-500">
              {opened.output.changedFiles.map((f) => (
                <div key={f} className="truncate">
                  {f}
                </div>
              ))}
            </div>
          )}
          {opened.output?.output ? (
            <pre className="max-h-56 overflow-auto font-mono text-[11px] text-zinc-300 whitespace-pre-wrap break-words selectable">{opened.output.output}</pre>
          ) : (
            !opened.output?.error && <span className="text-zinc-600">{opened.status === 'running' ? 'Working…' : 'No output'}</span>
          )}
        </div>
      )}

      {view.error && !opened && <div className="border-t border-white/[0.06] px-3 py-2 text-red-300/90 whitespace-pre-wrap break-words">{view.error}</div>}
    </div>
  )
}

/** Agent turns and reported cost of a run, against its budget: "3/10 turns · $0.42 of $2". */
export function usage(view: RunView): string | null {
  const nodes = new Map((view.graph?.nodes ?? []).map((n) => [n.id, n]))
  const turns = view.steps.filter((s) => {
    const type = nodes.get(s.nodeId)?.type
    return type === 'anchor' || type === 'prompt' || type === 'agent'
  }).length
  const cost = view.steps.reduce((sum, s) => sum + (s.output?.costUsd ?? 0), 0)
  const budget = view.graph?.budget
  const parts = [
    `${turns}${budget?.maxTurns ? `/${budget.maxTurns}` : ''} turn${(budget?.maxTurns ?? turns) === 1 ? '' : 's'}`,
    cost > 0 || budget?.maxCostUsd ? `$${cost.toFixed(2)}${budget?.maxCostUsd ? ` of $${budget.maxCostUsd}` : ''}` : null
  ].filter(Boolean)
  return turns || cost ? parts.join(' · ') : null
}
