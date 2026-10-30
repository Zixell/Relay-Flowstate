import type { PipelineEdge, PipelineGraph, PipelineNode, SessionTarget } from './types'

/** A cycle, closed by its back-arrow `edgeId` (latch → header). */
export interface Loop {
  edgeId: string
  header: string
  /** Every block of the cycle — what the editor highlights. */
  body: Set<string>
}

/** Blocks that may run at the same time: they come after one block's arrows that fire together. */
export interface Fork {
  nodeId: string
  /** The arrows of the two concurrent branches. */
  edgeIds: string[]
  /** Blocks only one of the branches reaches. */
  exclusive: [Set<string>, Set<string>]
  /** Blocks both branches reach without a Join — they run once per branch. */
  shared: Set<string>
  /** Where the branches meet: the first shared blocks. */
  merges: Set<string>
}

export interface GraphAnalysis {
  nodes: Map<string, PipelineNode>
  outgoing: Map<string, PipelineEdge[]>
  incoming: Map<string, PipelineEdge[]>
  /** Arrows plus the jumps exhausted loops make to their `onExhausted` block — everywhere a run can go. */
  flow: Map<string, PipelineEdge[]>
  anchor: string | null
  /** Where a run starts: the first pre-block, or the anchor. */
  entry: string | null
  /** Starting blocks besides the entry — nothing leads to them. */
  extraEntries: string[]
  reachable: Set<string>
  backEdges: Set<string>
  loops: Map<string, Loop>
  /** Blocks that run before the anchor. */
  preNodes: Set<string>
  forks: Fork[]
}

/** The session a block takes a turn in; null for blocks that do not talk to an agent. */
export function sessionOf(node: PipelineNode): SessionTarget | null {
  switch (node.type) {
    case 'anchor':
    case 'prompt':
      return 'current'
    case 'agent':
      return node.session
    default:
      return null
  }
}

/** Blocks that take an agent turn — what a run's turn budget counts. */
export function isAgentTurn(node: PipelineNode): boolean {
  return node.type === 'anchor' || node.type === 'prompt' || node.type === 'agent'
}

/** Conditional and default arrows go first-match among themselves; each other arrow always fires. */
export function isRouted(edge: PipelineEdge): boolean {
  return edge.condition !== undefined || edge.isDefault === true
}

/** Graph facts both the validator and the engine rely on. Tolerates broken graphs. */
export function analyze(graph: PipelineGraph): GraphAnalysis {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]))
  const outgoing = new Map<string, PipelineEdge[]>()
  const incoming = new Map<string, PipelineEdge[]>()
  for (const id of nodes.keys()) {
    outgoing.set(id, [])
    incoming.set(id, [])
  }
  for (const e of graph.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue
    outgoing.get(e.from)!.push(e)
    incoming.get(e.to)!.push(e)
  }

  const flow = new Map([...outgoing].map(([id, list]) => [id, [...list]]))
  for (const e of graph.edges) {
    const target = e.onExhausted?.kind === 'goto' ? e.onExhausted.nodeId : null
    if (target && nodes.has(target) && flow.has(e.from)) flow.get(e.from)!.push({ id: `${e.id}:exhausted`, from: e.from, to: target })
  }

  const anchors = graph.nodes.filter((n) => n.type === 'anchor')
  const anchor = anchors.length === 1 ? anchors[0].id : null
  const reaches = (from: string, to: string): boolean => walk([from], outgoing).has(to)

  const sources = graph.nodes.filter((n) => incoming.get(n.id)!.length === 0).map((n) => n.id)
  let starts = anchor ? sources.filter((id) => reaches(id, anchor)) : sources
  // Everything loops back into the anchor — it is the start
  if (anchor && starts.length === 0) starts = [anchor]
  const entry = starts.length === 1 ? starts[0] : null
  const extraEntries = starts.length > 1 ? starts : []

  const reachable = entry ? walk([entry], flow) : new Set<string>()
  const backEdges = entry ? findBackEdges(entry, outgoing) : new Set<string>()

  const loops = new Map<string, Loop>()
  for (const e of graph.edges) {
    if (!backEdges.has(e.id)) continue
    // Natural loop: the header plus whatever reaches the latch without passing the header
    const body = walk([e.from], incoming, (edge) => edge.from, new Set([e.to]))
    body.add(e.to)
    loops.set(e.id, { edgeId: e.id, header: e.to, body })
  }

  const preNodes =
    entry && anchor && entry !== anchor ? walk([entry], outgoing, (edge) => edge.to, new Set([anchor])) : new Set<string>()

  const forks = findForks(reachable, nodes, outgoing, backEdges)

  return { nodes, outgoing, incoming, flow, anchor, entry, extraEntries, reachable, backEdges, loops, preNodes, forks }
}

/** Breadth-first walk; `stop` blocks are neither entered nor returned. */
function walk(
  start: string[],
  adjacency: Map<string, PipelineEdge[]>,
  next: (e: PipelineEdge) => string = (e) => e.to,
  stop: Set<string> = new Set(),
  follow: (e: PipelineEdge) => boolean = () => true
): Set<string> {
  const seen = new Set<string>()
  const queue = start.filter((id) => !stop.has(id))
  for (const id of queue) seen.add(id)
  while (queue.length) {
    const id = queue.shift()!
    for (const e of adjacency.get(id) ?? []) {
      if (!follow(e)) continue
      const n = next(e)
      if (stop.has(n) || seen.has(n)) continue
      seen.add(n)
      queue.push(n)
    }
  }
  return seen
}

/** Arrows into a block still on the depth-first path from the entry. */
function findBackEdges(entry: string, outgoing: Map<string, PipelineEdge[]>): Set<string> {
  const back = new Set<string>()
  const onPath = new Set<string>()
  const done = new Set<string>()
  const visit = (id: string): void => {
    onPath.add(id)
    for (const e of outgoing.get(id) ?? []) {
      if (onPath.has(e.to)) back.add(e.id)
      else if (!done.has(e.to)) visit(e.to)
    }
    onPath.delete(id)
    done.add(id)
  }
  visit(entry)
  return back
}

function findForks(
  reachable: Set<string>,
  nodes: Map<string, PipelineNode>,
  outgoing: Map<string, PipelineEdge[]>,
  backEdges: Set<string>
): Fork[] {
  const forks: Fork[] = []
  const joins = new Set([...nodes.values()].filter((n) => n.type === 'join').map((n) => n.id))
  for (const id of reachable) {
    const out = outgoing.get(id)!
    const groups = out.filter((e) => !isRouted(e)).map((e) => [e])
    const routed = out.filter(isRouted)
    if (routed.length) groups.push(routed)
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        // Forward arrows only, stopping at Joins and at the fork itself
        const branch = (g: PipelineEdge[]): Set<string> =>
          walk(g.map((e) => e.to), outgoing, (e) => e.to, new Set([...joins, id]), (e) => !backEdges.has(e.id))
        const a = branch(groups[i])
        const b = branch(groups[j])
        const shared = new Set([...a].filter((n) => b.has(n)))
        const firsts = new Set([...groups[i], ...groups[j]].map((e) => e.to))
        const merges = new Set(
          [...shared].filter(
            (n) =>
              firsts.has(n) ||
              [...a, ...b].some((p) => !shared.has(p) && outgoing.get(p)!.some((e) => e.to === n && !backEdges.has(e.id)))
          )
        )
        forks.push({
          nodeId: id,
          edgeIds: [...groups[i], ...groups[j]].map((e) => e.id),
          exclusive: [new Set([...a].filter((n) => !shared.has(n))), new Set([...b].filter((n) => !shared.has(n)))],
          shared,
          merges
        })
      }
    }
  }
  return forks
}
