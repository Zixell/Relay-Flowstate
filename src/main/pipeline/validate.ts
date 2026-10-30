import { analyze, sessionOf, type GraphAnalysis } from './graph'
import type { PipelineGraph, PipelineNode } from './types'

export interface ValidationIssue {
  /** An error blocks saving; a warning is shown but allowed. */
  level: 'error' | 'warning'
  code:
    | 'anchor-count'
    | 'duplicate-id'
    | 'dangling-edge'
    | 'multiple-entries'
    | 'unreachable'
    | 'loop-limit'
    | 'exhausted-target'
    | 'missing-default'
    | 'multiple-defaults'
    | 'default-without-conditions'
    | 'condition-and-default'
    | 'pre-current-session'
    | 'parallel-current-session'
    | 'parallel-merge'
    | 'join-inputs'
    | 'node-config'
  message: string
  nodeIds?: string[]
  edgeIds?: string[]
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
  analysis: GraphAnalysis
}

export function validate(graph: PipelineGraph): ValidationResult {
  const issues: ValidationIssue[] = []
  const error = (i: Omit<ValidationIssue, 'level'>): number => issues.push({ level: 'error', ...i })
  const warn = (i: Omit<ValidationIssue, 'level'>): number => issues.push({ level: 'warning', ...i })
  const a = analyze(graph)
  const name = (id: string): string => a.nodes.get(id)?.label || id

  const anchors = graph.nodes.filter((n) => n.type === 'anchor')
  if (anchors.length !== 1) {
    error({
      code: 'anchor-count',
      message: anchors.length ? 'A pipeline has exactly one Input prompt block' : 'The Input prompt block is missing',
      nodeIds: anchors.map((n) => n.id)
    })
  }

  for (const [list, what] of [
    [graph.nodes, 'block'],
    [graph.edges, 'arrow']
  ] as const) {
    const seen = new Set<string>()
    for (const item of list) {
      if (seen.has(item.id)) error({ code: 'duplicate-id', message: `Two ${what}s share the id "${item.id}"` })
      seen.add(item.id)
    }
  }

  for (const e of graph.edges) {
    if (!a.nodes.has(e.from) || !a.nodes.has(e.to)) {
      error({ code: 'dangling-edge', message: 'An arrow points to a block that does not exist', edgeIds: [e.id] })
    }
  }

  if (a.extraEntries.length) {
    error({
      code: 'multiple-entries',
      message: 'Several chains lead into Input prompt — connect them into one',
      nodeIds: a.extraEntries
    })
  }
  if (a.entry) {
    const lost = graph.nodes.filter((n) => !a.reachable.has(n.id) && !a.extraEntries.includes(n.id))
    if (lost.length) {
      error({ code: 'unreachable', message: 'Not connected to the pipeline', nodeIds: lost.map((n) => n.id) })
    }
  }

  for (const loop of a.loops.values()) {
    const edge = graph.edges.find((e) => e.id === loop.edgeId)!
    if (!edge.maxIterations || edge.maxIterations < 1 || !Number.isInteger(edge.maxIterations)) {
      error({
        code: 'loop-limit',
        message: 'This cycle needs a maximum number of iterations',
        nodeIds: [...loop.body],
        edgeIds: [edge.id]
      })
    }
    if (edge.onExhausted?.kind === 'goto') {
      const target = edge.onExhausted.nodeId
      if (!a.nodes.has(target)) {
        error({ code: 'exhausted-target', message: 'The block to go to after the last iteration does not exist', edgeIds: [edge.id] })
      } else if (a.nodes.get(target)!.type === 'join') {
        error({ code: 'exhausted-target', message: 'After the last iteration the pipeline cannot go to a Join', edgeIds: [edge.id] })
      } else if (target === edge.from || reachesThrough(a, target, edge.from)) {
        // It would come back to the exhausted arrow and go there again, forever
        error({
          code: 'exhausted-target',
          message: `After the last iteration the pipeline must leave the cycle — "${name(target)}" leads back into it`,
          nodeIds: [target],
          edgeIds: [edge.id]
        })
      }
    }
  }

  for (const node of graph.nodes) {
    const out = a.outgoing.get(node.id) ?? []
    const conditional = out.filter((e) => e.condition)
    const defaults = out.filter((e) => e.isDefault)
    for (const e of out.filter((e) => e.condition && e.isDefault)) {
      error({ code: 'condition-and-default', message: 'An arrow is either conditional or the default, not both', edgeIds: [e.id] })
    }
    if (conditional.length && !defaults.length) {
      error({
        code: 'missing-default',
        message: `"${name(node.id)}" has conditional arrows but no default — the pipeline would stop silently when none matches`,
        nodeIds: [node.id],
        edgeIds: conditional.map((e) => e.id)
      })
    }
    if (defaults.length > 1) {
      error({ code: 'multiple-defaults', message: `"${name(node.id)}" has more than one default arrow`, edgeIds: defaults.map((e) => e.id) })
    }
    if (defaults.length && !conditional.length) {
      error({
        code: 'default-without-conditions',
        message: 'A default arrow needs conditional arrows next to it — make it a plain arrow',
        edgeIds: defaults.map((e) => e.id)
      })
    }
    if (node.type === 'join' && (a.incoming.get(node.id)?.length ?? 0) < 2) {
      warn({ code: 'join-inputs', message: 'Join waits for several branches but has fewer than two arrows in', nodeIds: [node.id] })
    }
    const config = configProblem(node)
    if (config) error({ code: 'node-config', message: `"${name(node.id)}": ${config}`, nodeIds: [node.id] })
  }

  const preCurrent = [...a.preNodes].filter((id) => sessionOf(a.nodes.get(id)!) === 'current')
  if (preCurrent.length) {
    error({
      code: 'pre-current-session',
      message: 'Blocks before Input prompt run in a new session — the chat session must see the user message first',
      nodeIds: preCurrent
    })
  }

  const reported = new Set<string>()
  for (const fork of a.forks) {
    const current = (ids: Set<string>): string[] => [...ids].filter((id) => sessionOf(a.nodes.get(id)!) === 'current')
    const [left, right] = fork.exclusive.map(current)
    const shared = current(fork.shared)
    if ((left.length && right.length) || ((left.length || right.length) && shared.length)) {
      error({
        code: 'parallel-current-session',
        message: 'Parallel branches both use the current session, which runs one turn at a time — move one to a new session',
        nodeIds: [...left, ...right, ...shared],
        edgeIds: fork.edgeIds
      })
    }
    const merges = [...fork.merges].filter((id) => !reported.has(id))
    if (merges.length) {
      merges.forEach((id) => reported.add(id))
      warn({
        code: 'parallel-merge',
        message: 'Parallel branches meet here without a Join — this block will run once per branch',
        nodeIds: merges
      })
    }
  }

  return { ok: !issues.some((i) => i.level === 'error'), issues, analysis: a }
}

/** Whether `from` leads to `to` along arrows. */
function reachesThrough(a: GraphAnalysis, from: string, to: string): boolean {
  const seen = new Set([from])
  const queue = [from]
  while (queue.length) {
    for (const e of a.outgoing.get(queue.shift()!) ?? []) {
      if (e.to === to) return true
      if (!seen.has(e.to)) {
        seen.add(e.to)
        queue.push(e.to)
      }
    }
  }
  return false
}

function configProblem(node: PipelineNode): string | null {
  switch (node.type) {
    case 'agent':
    case 'prompt':
      return node.prompt.trim() ? null : 'the prompt is empty'
    case 'tool':
      return node.server && node.tool ? null : 'choose an MCP server and a tool'
    case 'action':
      if (node.action === 'shell' && !node.command.trim()) return 'the command is empty'
      if (node.action === 'notify' && !node.message.trim()) return 'the message is empty'
      return null
    default:
      return null
  }
}
