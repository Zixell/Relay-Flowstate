import React, { useEffect, useState } from 'react'
import { Loader2, Workflow } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import type { Pipeline, PipelineGraph } from '../../../../main/pipeline/types'
import { PipelineEditor } from './PipelineEditor'
import { RunsView } from './RunsView'
import { TEMPLATES } from './templates'
import { cn } from '../../lib/utils'

/** The task's Pipeline tab: the pipeline itself, and the runs it made. */
export function TaskPipeline({ taskId }: { taskId: string }) {
  const runFocus = useAppStore((s) => s.pipelineRunFocus)
  const focusPipelineRun = useAppStore((s) => s.focusPipelineRun)
  const [view, setView] = useState<'setup' | 'runs'>('setup')
  const [focusRunId, setFocusRunId] = useState<string | null>(null)

  useEffect(() => {
    if (runFocus?.taskId !== taskId) return
    setView('runs')
    setFocusRunId(runFocus.runId)
    focusPipelineRun(null)
  }, [runFocus, taskId, focusPipelineRun])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-4 h-10 border-b border-white/[0.06] bg-[#0d0d0d] shrink-0">
        {(
          [
            ['setup', 'Pipeline'],
            ['runs', 'Runs']
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={cn(
              'h-7 px-3 rounded-md text-xs',
              view === id ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03]'
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">{view === 'runs' ? <RunsView taskId={taskId} focusRunId={focusRunId} /> : <PipelineSetup taskId={taskId} />}</div>
    </div>
  )
}

/** The task's own pipeline, or what applies instead and a way to make one. */
function PipelineSetup({ taskId }: { taskId: string }) {
  const openGlobalPipeline = useAppStore((s) => s.openGlobalPipeline)
  const isGlobalPipelineOpen = useAppStore((s) => s.isGlobalPipelineOpen)
  const [loaded, setLoaded] = useState(false)
  const [own, setOwn] = useState<Pipeline | null>(null)
  const [global, setGlobal] = useState<Pipeline | null>(null)
  /** A new pipeline being drawn, not saved yet. */
  const [draft, setDraft] = useState<{ template?: PipelineGraph; name?: string } | null>(null)

  useEffect(() => {
    // The global one may have just been edited in its dialog
    if (isGlobalPipelineOpen) return
    let cancelled = false
    Promise.all([window.api.pipelines.get(taskId), window.api.pipelines.get(null)]).then(([mine, shared]) => {
      if (cancelled) return
      setOwn(mine)
      setGlobal(shared)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [taskId, isGlobalPipelineOpen])

  if (!loaded) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
      </div>
    )
  }

  if (own || draft) {
    return (
      <PipelineEditor
        key={own?.id ?? 'draft'}
        scope={{ kind: 'task', taskId }}
        pipeline={own}
        template={draft?.template}
        templateName={draft?.name}
        onSaved={(p) => {
          setOwn(p)
          setDraft(null)
        }}
        onDeleted={() => {
          setOwn(null)
          setDraft(null)
        }}
        onClose={own ? undefined : () => setDraft(null)}
      />
    )
  }

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-xl flex flex-col items-center gap-3 text-center">
        <Workflow className="w-6 h-6 text-violet-300/70" />
        <p className="text-sm font-medium text-zinc-200">No pipeline for this task</p>
        <p className="text-xs text-zinc-500 leading-relaxed">
          {global ? (
            <>
              Messages go through the global pipeline <span className="text-zinc-300">«{global.name}»</span>. A pipeline of the task replaces it.
            </>
          ) : (
            'Messages go straight to the agent. A pipeline can run steps around each message: a review, a commit, a fix loop.'
          )}
        </p>
        <div className="flex flex-wrap justify-center gap-2 pt-2">
          <button
            onClick={() => setDraft({})}
            className="h-8 px-3 rounded-lg text-xs font-medium bg-violet-500/90 text-white hover:bg-violet-500"
          >
            Create a pipeline for this task
          </button>
          {global && (
            <button
              onClick={() => setDraft({ template: { nodes: global.nodes, edges: global.edges } })}
              className="h-8 px-3 rounded-lg text-xs text-zinc-300 border border-white/[0.1] hover:bg-white/[0.05]"
            >
              Start from the global one
            </button>
          )}
          <button onClick={openGlobalPipeline} className="h-8 px-3 rounded-lg text-xs text-zinc-300 border border-white/[0.1] hover:bg-white/[0.05]">
            {global ? 'Edit the global pipeline' : 'Create a global pipeline'}
          </button>
        </div>
        <p className="pt-4 text-[11px] uppercase tracking-wide text-zinc-600">Or start from a template</p>
        <div className="grid grid-cols-2 gap-2 w-full">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => setDraft({ template: t.graph, name: t.name })}
              className="text-left rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 hover:bg-white/[0.05] hover:border-white/[0.14]"
            >
              <p className="text-[12px] text-zinc-200">{t.name}</p>
              <p className="text-[11px] text-zinc-500 leading-snug mt-1">{t.description}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** The global pipeline's editor over the whole window. */
export function GlobalPipelineDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<{ pipeline: Pipeline | null } | null>(null)

  useEffect(() => {
    window.api.pipelines.get(null).then((pipeline) => setState({ pipeline }))
  }, [])

  return (
    <div className="fixed inset-0 z-50 bg-black/70 p-6 select-none">
      <div className="h-full rounded-xl border border-white/[0.08] overflow-hidden shadow-2xl">
        {state ? (
          <PipelineEditor
            scope={{ kind: 'global' }}
            pipeline={state.pipeline}
            onSaved={(pipeline) => setState({ pipeline })}
            onDeleted={onClose}
            onClose={onClose}
          />
        ) : (
          <div className="h-full flex items-center justify-center bg-[#0a0a0a]">
            <Loader2 className="w-4 h-4 animate-spin text-zinc-600" />
          </div>
        )}
      </div>
    </div>
  )
}
