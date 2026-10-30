import React, { useEffect, useMemo, useState } from 'react'
import { ReactFlow, ReactFlowProvider, Background, Controls, MarkerType } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Check, ChevronRight, Loader2, Minus, Wrench, X } from 'lucide-react'
import { cn, formatRelativeTime } from '../../lib/utils'
import { useAppStore } from '../../stores/appStore'
import type { PipelineRunRow, RunStatus, TranscriptItem } from '../../../../main/pipeline/types'
import { apply, fromRows, type RunView, type StepView } from '../chat/PipelineProgress'
import { MarksContext, edgeTypes, nodeTypes, type ArrowEdgeType, type BlockNodeType, type Marks } from './canvas'
import { blockTitle, layout } from './model'
import { analyze } from '../../../../main/pipeline/graph'

const RUN_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  completed: 'Passed',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted'
}

function StatusIcon({ status, className }: { status: StepView['status'] | RunStatus; className?: string }) {
  if (status === 'running') return <Loader2 className={cn('w-3.5 h-3.5 animate-spin text-blue-300', className)} />
  if (status === 'ok' || status === 'completed') return <Check className={cn('w-3.5 h-3.5 text-emerald-400', className)} strokeWidth={3} />
  if (status === 'error' || status === 'failed') return <X className={cn('w-3.5 h-3.5 text-red-400', className)} strokeWidth={3} />
  return <Minus className={cn('w-3.5 h-3.5 text-zinc-500', className)} strokeWidth={3} />
}

/** The task's pipeline runs: a list, the chosen run painted on its graph, and what each block did. */
export function RunsView({ taskId, focusRunId }: { taskId: string; focusRunId?: string | null }) {
  const [runs, setRuns] = useState<PipelineRunRow[] | null>(null)
  const [selected, setSelected] = useState<string | null>(focusRunId ?? null)

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      void window.api.pipelines.runs(taskId).then((list) => {
        if (cancelled) return
        setRuns(list)
        setSelected((cur) => cur ?? list[0]?.id ?? null)
      })
    }
    load()
    // New runs and status changes refresh the list
    const unsub = window.api.pipelines.onEvent(taskId, (e) => {
      if (e.type === 'run.started' || e.type === 'run.completed') load()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [taskId])

  useEffect(() => {
    if (focusRunId) setSelected(focusRunId)
  }, [focusRunId])

  if (!runs) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
      </div>
    )
  }
  if (!runs.length) {
    return <div className="h-full flex items-center justify-center text-xs text-zinc-500">No pipeline has run in this task yet.</div>
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 shrink-0 border-r border-white/[0.06] bg-[#0d0d0d] overflow-y-auto">
        {runs.map((r) => (
          <button
            key={r.id}
            onClick={() => setSelected(r.id)}
            className={cn(
              'w-full flex items-start gap-2 px-3 py-2.5 text-left border-b border-white/[0.04] hover:bg-white/[0.03]',
              selected === r.id && 'bg-white/[0.05]'
            )}
          >
            <StatusIcon status={r.status} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-zinc-200 truncate">{r.input || '(empty message)'}</p>
              <p className="text-[10.5px] text-zinc-500">
                {RUN_LABEL[r.status]} · {formatRelativeTime(r.started_at)}
              </p>
            </div>
          </button>
        ))}
      </div>
      {selected && (
        <ReactFlowProvider key={selected}>
          <RunDetail runId={selected} taskId={taskId} />
        </ReactFlowProvider>
      )}
    </div>
  )
}

function RunDetail({ runId, taskId }: { runId: string; taskId: string }) {
  const agents = useAppStore((s) => s.agents)
  const [view, setView] = useState<RunView | null>(null)
  const [node, setNode] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let early: Parameters<typeof apply>[1][] | null = []
    const unsub = window.api.pipelines.onEvent(taskId, (e) => {
      if (e.runId !== runId) return
      if (early) early.push(e)
      else setView((v) => (v ? apply(v, e) : v))
    })
    void window.api.pipelines.run(runId).then((res) => {
      if (cancelled || !res) return
      let v = fromRows(res.run, res.steps)
      for (const e of early ?? []) v = apply(v, e)
      early = null
      setView(v)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [runId, taskId])

  const graph = useMemo(() => (view?.graph ? layout(view.graph) : null), [view?.graph])
  const nodes = useMemo<BlockNodeType[]>(
    () =>
      (graph?.nodes ?? []).map((b) => ({
        id: b.id,
        type: 'block',
        position: b.position ?? { x: 0, y: 0 },
        data: { block: b },
        selected: b.id === node,
        draggable: false,
        connectable: false
      })),
    [graph, node]
  )
  const edges = useMemo<ArrowEdgeType[]>(
    () =>
      (graph?.edges ?? []).map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        type: 'arrow',
        data: { edge: e },
        selectable: false,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#a1a1aa', width: 16, height: 16 }
      })),
    [graph]
  )
  const loops = useMemo(() => (graph ? analyze(graph).backEdges : new Set<string>()), [graph])
  const marks = useMemo<Marks>(() => {
    const run: NonNullable<Marks['run']> = {}
    for (const s of view?.steps ?? []) run[s.nodeId] = { status: s.status, rounds: (run[s.nodeId]?.rounds ?? 0) + 1 }
    return {
      errors: new Set(),
      warnings: new Set(),
      loops,
      unboundedLoop: new Set(),
      agentLabels: Object.fromEntries(agents.map((a) => [a.id, a.label])),
      run
    }
  }, [view?.steps, agents, loops])

  if (!view || !graph) {
    return (
      <div className="flex-1 flex justify-center py-10">
        <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
      </div>
    )
  }

  const block = graph.nodes.find((n) => n.id === node)
  const rounds = view.steps.filter((s) => s.nodeId === node)

  return (
    <MarksContext.Provider value={marks}>
      <div className="relative flex-1 min-w-0 [&_*::selection]:bg-transparent">
        <div className="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-lg border border-white/[0.08] bg-[#111]/95 px-3 py-1.5 text-[12px]">
          <StatusIcon status={view.status} />
          <span className="text-zinc-200">{view.name}</span>
          <span className="text-zinc-500">{RUN_LABEL[view.status]}</span>
          {view.status === 'running' && (
            <button onClick={() => window.api.pipelines.cancel(taskId)} className="ml-1 text-[11px] text-zinc-400 hover:text-zinc-100">
              Stop
            </button>
          )}
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={(_, n) => setNode(n.id)}
          onPaneClick={() => setNode(null)}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          nodesDraggable={false}
          nodesConnectable={false}
          deleteKeyCode={null}
          minZoom={0.3}
        >
          <Background gap={20} size={1} color="#262626" />
          <Controls showInteractive={false} />
        </ReactFlow>
        {view.error && (
          <div className="absolute left-14 bottom-3 z-10 max-w-md rounded-lg border border-red-500/30 bg-[#111]/95 px-3 py-2 text-[12px] text-red-300 whitespace-pre-wrap break-words">
            {view.error}
          </div>
        )}
      </div>

      <div className="w-96 shrink-0 border-l border-white/[0.06] bg-[#0d0d0d] overflow-y-auto">
        {block ? (
          <div className="p-4 flex flex-col gap-3">
            <p className="text-[13px] font-medium text-zinc-100">{blockTitle(block)}</p>
            {!rounds.length && <p className="text-[12px] text-zinc-500">The run did not reach this block.</p>}
            {rounds.map((s, i) => (
              <Round key={s.id} step={s} label={rounds.length > 1 ? `Round ${i + 1}` : 'Result'} defaultOpen={i === rounds.length - 1} />
            ))}
          </div>
        ) : (
          <div className="p-4 text-[12px] text-zinc-500 leading-relaxed">
            <p className="text-zinc-300 text-[13px] font-medium mb-2">Message</p>
            <p className="whitespace-pre-wrap break-words text-zinc-400 select-text">{view.input}</p>
            <p className="mt-4">Select a block to see what it did in each round.</p>
          </div>
        )}
      </div>
    </MarksContext.Provider>
  )
}

function Round({ step, label, defaultOpen }: { step: StepView; label: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const [transcript, setTranscript] = useState<TranscriptItem[] | 'loading' | null>(null)
  const out = step.output

  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.015]">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-white/[0.03]">
        <ChevronRight className={cn('w-3 h-3 text-zinc-600 transition-transform', open && 'rotate-90')} />
        <StatusIcon status={step.status} />
        <span className="text-zinc-300">{label}</span>
        {step.endedAt && <span className="ml-auto text-[10.5px] text-zinc-600">{Math.max(0, Math.round(step.endedAt - step.startedAt))}s</span>}
      </button>
      {open && (
        <div className="border-t border-white/[0.05] px-3 py-2 flex flex-col gap-2 text-[11.5px] select-text">
          {step.status === 'running' && <span className="text-zinc-500">Working…</span>}
          {step.status === 'cancelled' && <span className="text-zinc-500">Stopped before it finished.</span>}
          {out?.error && <div className="text-red-300/90 whitespace-pre-wrap break-words">{out.error}</div>}
          {out?.changedFiles && out.changedFiles.length > 0 && (
            <div className="font-mono text-[11px] text-zinc-500">
              {out.changedFiles.map((f) => (
                <div key={f} className="truncate">
                  {f}
                </div>
              ))}
            </div>
          )}
          {out?.output && <pre className="max-h-80 overflow-auto font-mono text-zinc-300 whitespace-pre-wrap break-words selectable">{out.output}</pre>}
          {out?.json !== undefined && (
            <pre className="max-h-48 overflow-auto font-mono text-zinc-400 whitespace-pre-wrap break-words border-t border-white/[0.04] pt-2 selectable">
              {JSON.stringify(out.json, null, 2)}
            </pre>
          )}
          {out?.sessionId && transcript === null && (
            <button
              onClick={() => {
                setTranscript('loading')
                void window.api.pipelines
                  .transcript(step.id)
                  .then(setTranscript)
                  .catch(() => setTranscript([]))
              }}
              className="self-start text-[11px] text-violet-300 hover:text-violet-200"
            >
              Show the agent's session
            </button>
          )}
          {transcript === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-600" />}
          {Array.isArray(transcript) && <Transcript items={transcript} />}
        </div>
      )}
    </div>
  )
}

function Transcript({ items }: { items: TranscriptItem[] }) {
  if (!items.length) return <span className="text-zinc-600">The session's history is not available.</span>
  return (
    <div className="flex flex-col gap-1.5 border-t border-white/[0.04] pt-2">
      {items.map((it, i) =>
        it.kind === 'tool' ? (
          <div key={i} className="flex items-center gap-1.5 text-zinc-500 font-mono text-[11px]">
            <Wrench className="w-3 h-3 shrink-0" />
            <span className="truncate">{it.text}</span>
            {it.status === 'error' && <X className="w-3 h-3 text-red-400 shrink-0" />}
          </div>
        ) : (
          <div
            key={i}
            className={cn(
              'whitespace-pre-wrap break-words selectable',
              it.kind === 'user' ? 'text-zinc-400 border-l-2 border-violet-500/40 pl-2' : 'text-zinc-300'
            )}
          >
            {it.text}
          </div>
        )
      )}
    </div>
  )
}
