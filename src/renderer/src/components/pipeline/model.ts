import type { Condition, PipelineEdge, PipelineGraph, PipelineNode } from '../../../../main/pipeline/types'

/** Blocks the palette offers. */
export type BlockKind = 'agent' | 'prompt' | 'tool' | 'commit' | 'shell' | 'notify' | 'join'

export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    issues: { type: 'array', items: { type: 'string' } }
  },
  required: ['verdict']
}

export const emptyGraph = (): PipelineGraph => ({
  nodes: [{ id: 'anchor', type: 'anchor', position: { x: 0, y: 0 } }],
  edges: []
})

const ID_BASE: Record<BlockKind, string> = {
  agent: 'agent',
  prompt: 'prompt',
  tool: 'tool',
  commit: 'commit',
  shell: 'shell',
  notify: 'notify',
  join: 'join'
}

/** A readable id that is not taken yet: `review`, `review2`, … */
export function freeId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const clean = base.replace(/[^\w-]/g, '') || 'block'
  if (!used.has(clean)) return clean
  for (let i = 2; ; i++) if (!used.has(`${clean}${i}`)) return `${clean}${i}`
}

export function newBlock(kind: BlockKind, taken: Iterable<string>, position: { x: number; y: number }): PipelineNode {
  const id = freeId(ID_BASE[kind], taken)
  switch (kind) {
    case 'agent':
      return { id, type: 'agent', session: 'new', prompt: '', position }
    case 'prompt':
      return { id, type: 'prompt', prompt: '', position }
    case 'tool':
      return { id, type: 'tool', server: '', tool: '', args: {}, position }
    case 'commit':
      return { id, type: 'action', action: 'commit', message: '', position }
    case 'shell':
      return { id, type: 'action', action: 'shell', command: '', position }
    case 'notify':
      return { id, type: 'action', action: 'notify', message: '', position }
    case 'join':
      return { id, type: 'join', position }
  }
}

export function blockTitle(node: PipelineNode): string {
  if (node.label) return node.label
  switch (node.type) {
    case 'anchor':
      return 'Input prompt'
    case 'agent':
      return 'Agent step'
    case 'prompt':
      return 'Prompt'
    case 'tool':
      return 'Tool call'
    case 'join':
      return 'Join'
    case 'action':
      return node.action === 'commit' ? 'Commit' : node.action === 'shell' ? 'Shell command' : 'Notify'
  }
}

/** One line under the title: what the block will do. */
export function blockPreview(node: PipelineNode): string {
  switch (node.type) {
    case 'anchor':
      return node.prompt?.trim() && node.prompt.trim() !== '{{input}}' ? node.prompt : 'The message, handled by the chat agent'
    case 'agent':
    case 'prompt':
      return node.prompt
    case 'action':
      return node.action === 'shell' ? node.command : (node.message ?? '')
    case 'join':
      return 'Waits for the parallel branches'
    case 'tool':
      return `${node.server} · ${node.tool}`
  }
}

const OPS: Record<string, string> = { eq: '=', neq: '≠', contains: 'contains', matches: '~', gt: '>', lt: '<', exists: 'exists' }

export function conditionSummary(c: Condition): string {
  switch (c.kind) {
    case 'status':
      return c.equals === 'error' ? 'failed' : 'succeeded'
    case 'filesChanged':
      return c.glob ? `changed ${c.glob}` : 'files changed'
    case 'output': {
      const field = c.path.replace(/^json\./, '')
      return c.op === 'exists' ? `${field} exists` : `${field} ${OPS[c.op]} ${String(c.value ?? '')}`
    }
    case 'not':
      return `not (${conditionSummary(c.of)})`
    case 'all':
    case 'any':
      return c.of.map(conditionSummary).join(c.kind === 'all' ? ' and ' : ' or ')
  }
}

export function edgeLabel(edge: PipelineEdge, isLoop: boolean): string {
  const parts: string[] = []
  if (edge.isDefault) parts.push('else')
  else if (edge.condition) parts.push(`${edge.order !== undefined ? `${edge.order}. ` : ''}${conditionSummary(edge.condition)}`)
  if (isLoop) parts.push(edge.maxIterations ? `↻ ≤${edge.maxIterations}` : '↻ set a limit')
  return parts.join(' · ')
}

/** Renames a block everywhere: arrows, loop exits and templates that mention it. */
export function renameBlock(graph: PipelineGraph, from: string, to: string): PipelineGraph {
  const ref = new RegExp(`\\{\\{\\s*${from.replace(/[-]/g, '\\-')}(?=[\\s.}])`, 'g')
  const fix = (s: string): string => s.replace(ref, `{{${to}`)
  return {
    nodes: graph.nodes.map((n) => {
      const node: PipelineNode = n.id === from ? { ...n, id: to } : n
      switch (node.type) {
        case 'anchor':
          return node.prompt ? { ...node, prompt: fix(node.prompt) } : node
        case 'agent':
        case 'prompt':
          return { ...node, prompt: fix(node.prompt) }
        case 'action':
          if (node.action === 'shell') return node
          return node.message !== undefined ? { ...node, message: fix(node.message) } : node
        default:
          return node
      }
    }),
    edges: graph.edges.map((e) => ({
      ...e,
      from: e.from === from ? to : e.from,
      to: e.to === from ? to : e.to,
      onExhausted: e.onExhausted?.kind === 'goto' && e.onExhausted.nodeId === from ? { kind: 'goto', nodeId: to } : e.onExhausted
    }))
  }
}

/** Positions for blocks that have none: columns by distance from the start. */
export function layout(graph: PipelineGraph): PipelineGraph {
  if (graph.nodes.every((n) => n.position)) return graph
  const depth = new Map<string, number>()
  const start = graph.nodes.find((n) => !graph.edges.some((e) => e.to === n.id)) ?? graph.nodes.find((n) => n.type === 'anchor')
  if (start) {
    depth.set(start.id, 0)
    const queue = [start.id]
    while (queue.length) {
      const id = queue.shift()!
      for (const e of graph.edges.filter((x) => x.from === id)) {
        if (depth.has(e.to)) continue
        depth.set(e.to, depth.get(id)! + 1)
        queue.push(e.to)
      }
    }
  }
  const rows = new Map<number, number>()
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.position) return n
      const col = depth.get(n.id) ?? 0
      const row = rows.get(col) ?? 0
      rows.set(col, row + 1)
      return { ...n, position: { x: col * 300, y: row * 150 } }
    })
  }
}
