import React, { useEffect, useState } from 'react'
import { Loader2, Workflow } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import type { Pipeline, PipelineGraph } from '../../../../main/pipeline/types'
import { PipelineEditor } from './PipelineEditor'

/** The task's Pipeline tab: its own pipeline, or what applies instead and a way to make one. */
export function TaskPipeline({ taskId }: { taskId: string }) {
  const openGlobalPipeline = useAppStore((s) => s.openGlobalPipeline)
  const isGlobalPipelineOpen = useAppStore((s) => s.isGlobalPipelineOpen)
  const [loaded, setLoaded] = useState(false)
  const [own, setOwn] = useState<Pipeline | null>(null)
  const [global, setGlobal] = useState<Pipeline | null>(null)
  /** A new pipeline being drawn, not saved yet. */
  const [draft, setDraft] = useState<{ template?: PipelineGraph } | null>(null)

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
      <div className="max-w-md flex flex-col items-center gap-3 text-center">
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
