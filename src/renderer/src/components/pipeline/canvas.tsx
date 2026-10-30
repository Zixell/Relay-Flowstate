import React, { createContext, memo, useContext } from 'react'
import { BaseEdge, EdgeLabelRenderer, Handle, Position, getBezierPath, type EdgeProps, type NodeProps, type Node, type Edge } from '@xyflow/react'
import { Bot, MessageSquareText, GitCommitHorizontal, TerminalSquare, Bell, Merge, Inbox, Plug, Check, X, Loader2, Minus } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { PipelineEdge, PipelineNode } from '../../../../main/pipeline/types'
import { blockPreview, blockTitle, edgeLabel } from './model'

export type BlockNodeType = Node<{ block: PipelineNode }, 'block'>
export type ArrowEdgeType = Edge<{ edge: PipelineEdge }, 'arrow'>

/** What validation says about each block and arrow, so they can be painted without touching the graph. */
export interface Marks {
  errors: Set<string>
  warnings: Set<string>
  /** Arrows that close a loop. */
  loops: Set<string>
  /** Blocks of loops that still need a limit. */
  unboundedLoop: Set<string>
  agentLabels: Record<string, string>
  /** In a run view: how each block did (its latest round); blocks the run never reached are absent. */
  run?: Record<string, { status: 'running' | 'ok' | 'error' | 'cancelled'; rounds: number }>
}

export const MarksContext = createContext<Marks>({
  errors: new Set(),
  warnings: new Set(),
  loops: new Set(),
  unboundedLoop: new Set(),
  agentLabels: {}
})

function blockIcon(node: PipelineNode): React.ComponentType<{ className?: string }> {
  switch (node.type) {
    case 'anchor':
      return Inbox
    case 'agent':
      return Bot
    case 'prompt':
      return MessageSquareText
    case 'join':
      return Merge
    case 'tool':
      return Plug
    case 'action':
      return node.action === 'commit' ? GitCommitHorizontal : node.action === 'shell' ? TerminalSquare : Bell
  }
}

function sessionChip(node: PipelineNode, agentLabels: Record<string, string>): string | null {
  if (node.type === 'anchor' || node.type === 'prompt') return 'chat session'
  if (node.type !== 'agent') return null
  if (node.session === 'current') return 'chat session'
  return node.agent ? `new session · ${agentLabels[node.agent] ?? node.agent}` : 'new session'
}

export const BlockNode = memo(function BlockNode({ data, selected }: NodeProps<BlockNodeType>) {
  const marks = useContext(MarksContext)
  const node = data.block
  const Icon = blockIcon(node)
  const chip = sessionChip(node, marks.agentLabels)
  const preview = blockPreview(node)
  const anchor = node.type === 'anchor'
  const error = marks.errors.has(node.id)
  const warning = !error && marks.warnings.has(node.id)
  const ran = marks.run?.[node.id]

  return (
    <div
      className={cn(
        'w-[220px] rounded-xl border bg-[#141414] shadow-lg transition-colors select-none',
        anchor ? 'border-blue-500/40' : 'border-white/[0.1]',
        error && 'border-red-500/70',
        warning && 'border-amber-500/60',
        marks.unboundedLoop.has(node.id) && 'outline outline-1 outline-dashed outline-red-500/70 outline-offset-4',
        ran?.status === 'ok' && 'border-emerald-500/60',
        ran?.status === 'error' && 'border-red-500/70',
        ran?.status === 'running' && 'border-blue-400/70',
        marks.run && !ran && 'opacity-40',
        selected && 'ring-2 ring-white/40'
      )}
    >
      <Handle type="target" position={Position.Left} className="!w-2.5 !h-2.5 !bg-zinc-500 !border-[#141414]" />
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <Icon className={cn('w-3.5 h-3.5 shrink-0', anchor ? 'text-blue-400' : 'text-violet-300/80')} />
        <span className="text-[12.5px] font-medium text-zinc-100 truncate">{blockTitle(node)}</span>
        {ran ? (
          <span className="ml-auto flex items-center gap-1 shrink-0 text-[10.5px] text-zinc-500">
            {ran.rounds > 1 && <span>×{ran.rounds}</span>}
            {ran.status === 'ok' && <Check className="w-3.5 h-3.5 text-emerald-400" strokeWidth={3} />}
            {ran.status === 'error' && <X className="w-3.5 h-3.5 text-red-400" strokeWidth={3} />}
            {ran.status === 'running' && <Loader2 className="w-3.5 h-3.5 text-blue-300 animate-spin" />}
            {ran.status === 'cancelled' && <Minus className="w-3.5 h-3.5 text-zinc-500" strokeWidth={3} />}
          </span>
        ) : (
          <span className="ml-auto text-[10px] font-mono text-zinc-600 truncate max-w-[70px]">{node.id}</span>
        )}
      </div>
      {chip && <div className="px-3 pt-1 text-[10.5px] text-zinc-500">{chip}</div>}
      <div className={cn('px-3 pt-1 pb-2.5 text-[11px] leading-snug line-clamp-2', preview ? 'text-zinc-400' : 'text-zinc-600 italic')}>
        {preview || 'Not set up yet'}
      </div>
      <Handle type="source" position={Position.Right} className="!w-2.5 !h-2.5 !bg-violet-400 !border-[#141414]" />
    </div>
  )
})

export const ArrowEdge = memo(function ArrowEdge(props: EdgeProps<ArrowEdgeType>) {
  const marks = useContext(MarksContext)
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd } = props
  const loop = marks.loops.has(id)
  // A loop goes back to the left: bend it under the blocks instead of through them
  const [path, labelX, labelY] = loop
    ? backPath(sourceX, sourceY, targetX, targetY)
    : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })
  const error = marks.errors.has(id)
  const label = data ? edgeLabel(data.edge, loop) : ''
  const color = error ? '#ef4444' : loop ? '#a78bfa' : data?.edge.isDefault ? '#71717a' : data?.edge.condition ? '#60a5fa' : '#a1a1aa'

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: color,
          strokeWidth: selected ? 2.5 : 1.5,
          strokeDasharray: loop ? '6 4' : undefined,
          // In a run view, arrows between blocks that both ran stand out
          opacity: marks.run && !(marks.run[source] && marks.run[target]) ? 0.25 : 1
        }}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            className={cn(
              'absolute pointer-events-auto nodrag nopan px-1.5 py-0.5 rounded-md text-[10.5px] border bg-[#0f0f0f] whitespace-nowrap',
              error ? 'border-red-500/50 text-red-300' : 'border-white/[0.08] text-zinc-300',
              selected && 'border-white/30'
            )}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

function backPath(sx: number, sy: number, tx: number, ty: number): [string, number, number] {
  const drop = Math.max(sy, ty) + 90
  const path = `M ${sx} ${sy} C ${sx + 60} ${sy}, ${sx + 60} ${drop}, ${sx} ${drop} L ${tx} ${drop} C ${tx - 60} ${drop}, ${tx - 60} ${ty}, ${tx} ${ty}`
  return [path, (sx + tx) / 2, drop]
}

export const nodeTypes = { block: BlockNode }
export const edgeTypes = { arrow: ArrowEdge }
