import React, { useCallback, useMemo, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MarkerType,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AlertTriangle, Bot, Bell, GitCommitHorizontal, Merge, MessageSquareText, Save, TerminalSquare, Trash2, X, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../stores/appStore'
import { validate } from '../../../../main/pipeline/validate'
import type { Pipeline, PipelineEdge, PipelineGraph, PipelineNode, PipelineScope, ValidationIssue } from '../../../../main/pipeline/types'
import { ArrowEdgeType, BlockNodeType, MarksContext, edgeTypes, nodeTypes, type Marks } from './canvas'
import { EdgeInspector, NodeInspector } from './Inspector'
import { emptyGraph, freeId, layout, newBlock, renameBlock, type BlockKind } from './model'

const PALETTE: { kind: BlockKind; label: string; hint: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { kind: 'agent', label: 'Agent step', hint: 'A prompt for an agent — in the chat session or a new one', icon: Bot },
  { kind: 'prompt', label: 'Prompt', hint: 'A message sent to the chat agent', icon: MessageSquareText },
  { kind: 'commit', label: 'Commit', hint: 'Commit every change in the worktree', icon: GitCommitHorizontal },
  { kind: 'shell', label: 'Shell command', hint: 'Run a command in the worktree', icon: TerminalSquare },
  { kind: 'notify', label: 'Notify', hint: 'Show a system notification', icon: Bell },
  { kind: 'join', label: 'Join', hint: 'Wait for parallel branches', icon: Merge }
]

const toNode = (block: PipelineNode): BlockNodeType => ({
  id: block.id,
  type: 'block',
  position: block.position ?? { x: 0, y: 0 },
  data: { block },
  deletable: block.type !== 'anchor'
})

const toEdge = (edge: PipelineEdge): ArrowEdgeType => ({
  id: edge.id,
  source: edge.from,
  target: edge.to,
  type: 'arrow',
  data: { edge },
  markerEnd: { type: MarkerType.ArrowClosed, color: '#a1a1aa', width: 16, height: 16 }
})

export interface PipelineEditorProps {
  scope: PipelineScope
  /** The saved pipeline, or null to start a new one (optionally from `template`). */
  pipeline: Pipeline | null
  template?: PipelineGraph
  onSaved?: (p: Pipeline) => void
  onDeleted?: () => void
  onClose?: () => void
}

export function PipelineEditor(props: PipelineEditorProps) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  )
}

function Editor({ scope, pipeline, template, onSaved, onDeleted, onClose }: PipelineEditorProps) {
  const agents = useAppStore((s) => s.agents)
  const flow = useReactFlow()
  const start = useMemo(() => layout(pipeline ?? template ?? emptyGraph()), [pipeline, template])
  const [nodes, setNodes] = useState<BlockNodeType[]>(() => start.nodes.map(toNode))
  const [edges, setEdges] = useState<ArrowEdgeType[]>(() => start.edges.map(toEdge))
  const [id] = useState(() => pipeline?.id ?? crypto.randomUUID())
  const [name, setName] = useState(pipeline?.name ?? (scope.kind === 'global' ? 'Global pipeline' : 'Task pipeline'))
  const [dirty, setDirty] = useState(!pipeline)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const graph = useMemo<PipelineGraph>(
    () => ({ nodes: nodes.map((n) => ({ ...n.data.block, position: n.position })), edges: edges.map((e) => e.data!.edge) }),
    [nodes, edges]
  )
  const { issues, analysis } = useMemo(() => validate(graph), [graph])
  const errors = issues.filter((i) => i.level === 'error')

  const marks = useMemo<Marks>(() => {
    const ids = (level: ValidationIssue['level']): Set<string> =>
      new Set(issues.filter((i) => i.level === level).flatMap((i) => [...(i.nodeIds ?? []), ...(i.edgeIds ?? [])]))
    return {
      errors: ids('error'),
      warnings: ids('warning'),
      loops: analysis.backEdges,
      unboundedLoop: new Set(issues.filter((i) => i.code === 'loop-limit').flatMap((i) => i.nodeIds ?? [])),
      agentLabels: Object.fromEntries(agents.map((a) => [a.id, a.label]))
    }
  }, [issues, analysis, agents])

  const selectedNode = nodes.find((n) => n.selected)
  const selectedEdge = selectedNode ? undefined : edges.find((e) => e.selected)

  const touch = (): void => {
    setDirty(true)
    setSaveError(null)
  }

  const onNodesChange = useCallback((changes: NodeChange<BlockNodeType>[]) => {
    const kept = changes.filter((c) => !(c.type === 'remove' && c.id === 'anchor'))
    setNodes((ns) => applyNodeChanges(kept, ns))
    if (kept.some((c) => c.type === 'position' || c.type === 'remove')) touch()
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange<ArrowEdgeType>[]) => {
    setEdges((es) => applyEdgeChanges(changes, es))
    if (changes.some((c) => c.type === 'remove')) touch()
  }, [])

  const onConnect = useCallback((c: Connection) => {
    // The new arrow opens in the inspector — a loop needs its limit right away
    setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)))
    setEdges((es) => {
      if (es.some((e) => e.source === c.source && e.target === c.target)) return es
      const edge: PipelineEdge = { id: freeId(`${c.source}-${c.target}`, es.map((e) => e.id)), from: c.source, to: c.target }
      return [...es.map((e) => ({ ...e, selected: false })), { ...toEdge(edge), selected: true }]
    })
    touch()
  }, [])

  const select = (target: { node?: string; edge?: string }): void => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === target.node })))
    setEdges((es) => es.map((e) => ({ ...e, selected: e.id === target.edge })))
  }

  /** Right of the selected block (or the rightmost one), on the first free row. */
  const freeSpot = (): { x: number; y: number } => {
    const from = selectedNode ?? nodes.reduce((a, b) => (b.position.x > a.position.x ? b : a), nodes[0])
    const spot = { x: from.position.x + 300, y: from.position.y }
    while (nodes.some((n) => Math.abs(n.position.x - spot.x) < 230 && Math.abs(n.position.y - spot.y) < 120)) spot.y += 140
    return spot
  }

  const addBlock = (kind: BlockKind): void => {
    const spot = freeSpot()
    const block = newBlock(kind, nodes.map((n) => n.id), spot)
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...toNode(block), selected: true }])
    setEdges((es) => es.map((e) => ({ ...e, selected: false })))
    void flow.setCenter(spot.x + 110, spot.y + 45, { zoom: flow.getZoom(), duration: 300 })
    touch()
  }

  const updateBlock = (block: PipelineNode): void => {
    setNodes((ns) => ns.map((n) => (n.id === block.id ? { ...n, data: { block } } : n)))
    touch()
  }

  const updateEdge = (edge: PipelineEdge): void => {
    setEdges((es) => es.map((e) => (e.id === edge.id ? { ...e, data: { edge } } : e)))
    touch()
  }

  const rename = (from: string, to: string): void => {
    const next = renameBlock(graph, from, to)
    setNodes(next.nodes.map((b) => ({ ...toNode(b), selected: b.id === to })))
    setEdges(next.edges.map(toEdge))
    touch()
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const p: Pipeline = { id, name: name.trim() || 'Pipeline', scope, ...graph }
      const result = await window.api.pipelines.save(p)
      const blocking = result.find((i) => i.level === 'error')
      if (blocking) setSaveError(blocking.message)
      else {
        setDirty(false)
        onSaved?.(p)
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    const what = scope.kind === 'global' ? 'the global pipeline' : "this task's pipeline"
    if (!window.confirm(`Delete ${what}? Messages will go straight to the agent${scope.kind === 'task' ? ' (or through the global pipeline)' : ''}.`)) return
    await window.api.pipelines.delete(scope.kind === 'task' ? scope.taskId : null)
    onDeleted?.()
  }

  return (
    <MarksContext.Provider value={marks}>
      <div className="flex flex-col h-full bg-[#0a0a0a]">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 h-12 border-b border-white/[0.06] bg-[#0d0d0d] shrink-0">
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              touch()
            }}
            className="bg-transparent text-[13px] font-medium text-zinc-100 focus:outline-none border-b border-transparent focus:border-white/20 w-64"
          />
          <span className="text-[11px] text-zinc-600">{scope.kind === 'global' ? 'Applies to every task without its own pipeline' : 'Only this task'}</span>
          <div className="ml-auto flex items-center gap-2">
            {saveError && <span className="text-[11px] text-red-300 truncate max-w-[320px]">{saveError}</span>}
            {!saveError && errors.length > 0 && <span className="text-[11px] text-red-300/80">Fix {errors.length} problem{errors.length > 1 ? 's' : ''} to save</span>}
            {!saveError && !errors.length && dirty && <span className="text-[11px] text-zinc-500">Unsaved changes</span>}
            {pipeline && (
              <button onClick={remove} title="Delete the pipeline" className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs text-zinc-400 hover:text-red-300 hover:bg-red-500/10">
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            )}
            <button
              onClick={save}
              disabled={saving || errors.length > 0 || !dirty}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium bg-violet-500/90 text-white hover:bg-violet-500 disabled:opacity-40 disabled:hover:bg-violet-500/90"
            >
              <Save className="w-3.5 h-3.5" />
              Save
            </button>
            {onClose && (
              <button onClick={() => (!dirty || window.confirm('Discard unsaved changes?')) && onClose()} title="Close" className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06]">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Palette */}
          <div className="w-48 shrink-0 border-r border-white/[0.06] bg-[#0d0d0d] p-3 flex flex-col gap-1.5 overflow-y-auto">
            <span className="text-[10.5px] uppercase tracking-wide text-zinc-600 px-1 pb-1">Add a block</span>
            {PALETTE.map((p) => (
              <button
                key={p.kind}
                onClick={() => addBlock(p.kind)}
                title={p.hint}
                className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[12px] text-zinc-300 border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.12]"
              >
                <p.icon className="w-3.5 h-3.5 text-violet-300/80 shrink-0" />
                {p.label}
              </button>
            ))}
            <p className="mt-3 px-1 text-[10.5px] text-zinc-600 leading-relaxed">
              Drag from a block's right dot to another block to connect them. Arrows without a condition run in parallel. Select and press Delete to remove.
            </p>
          </div>

          {/* Canvas */}
          {/* Dragging an arrow across blocks can leave a text selection painted on them */}
          <div className="relative flex-1 min-w-0 select-none [&_*::selection]:bg-transparent">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              colorMode="dark"
              fitView
              fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
              deleteKeyCode={['Backspace', 'Delete']}
              minZoom={0.3}
            >
              <Background gap={20} size={1} color="#262626" />
              <Controls showInteractive={false} />
            </ReactFlow>
            {issues.length > 0 && <IssueList issues={issues} onPick={select} />}
          </div>

          {/* Inspector */}
          <div className="w-80 shrink-0 border-l border-white/[0.06] bg-[#0d0d0d] p-4 overflow-y-auto">
            {selectedNode ? (
              <NodeInspector
                key={selectedNode.id}
                node={selectedNode.data.block}
                agents={agents}
                ids={nodes.map((n) => n.id).filter((x) => x !== selectedNode.id)}
                onChange={updateBlock}
                onRename={(to) => rename(selectedNode.id, to)}
                onDelete={() => void flow.deleteElements({ nodes: [{ id: selectedNode.id }] })}
              />
            ) : selectedEdge ? (
              <EdgeInspector
                key={selectedEdge.id}
                edge={selectedEdge.data!.edge}
                isLoop={analysis.backEdges.has(selectedEdge.id)}
                nodes={graph.nodes}
                onChange={updateEdge}
                onDelete={() => void flow.deleteElements({ edges: [{ id: selectedEdge.id }] })}
              />
            ) : (
              <div className="flex flex-col gap-3 text-[12px] text-zinc-500 leading-relaxed">
                <p className="text-zinc-300 text-[13px] font-medium">How it runs</p>
                <p>
                  <span className="text-blue-300">Input prompt</span> is the user's message handled by the chat agent as usual. Blocks before it run first;
                  the message waits.
                </p>
                <p>After a block finishes, its plain arrows all fire — in parallel. Of the conditional ones the first that matches fires, or the default.</p>
                <p>An arrow back to an earlier block makes a loop; it needs a maximum number of rounds.</p>
                <p>Select a block or an arrow to set it up.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </MarksContext.Provider>
  )
}

function IssueList({ issues, onPick }: { issues: ValidationIssue[]; onPick: (t: { node?: string; edge?: string }) => void }) {
  return (
    <div className="absolute left-14 bottom-3 z-10 max-w-md max-h-48 overflow-y-auto rounded-lg border border-white/[0.08] bg-[#111]/95 shadow-xl">
      {issues.map((i, n) => (
        <button
          key={n}
          onClick={() => onPick(i.edgeIds?.length && !i.nodeIds?.length ? { edge: i.edgeIds[0] } : { node: i.nodeIds?.[0], edge: i.nodeIds?.length ? undefined : i.edgeIds?.[0] })}
          className="w-full flex items-start gap-2 px-3 py-1.5 text-left text-[11.5px] hover:bg-white/[0.04]"
        >
          {i.level === 'error' ? <XCircle className="w-3.5 h-3.5 mt-px text-red-400 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-px text-amber-400 shrink-0" />}
          <span className={cn(i.level === 'error' ? 'text-red-200/90' : 'text-amber-200/80')}>{i.message}</span>
        </button>
      ))}
    </div>
  )
}
