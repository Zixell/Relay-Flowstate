import type { Condition, PipelineEdge, PipelineGraph, PipelineNode, SessionTarget } from '../types'

/** Terse graph builders for tests. */
export const anchor = (id = 'anchor', prompt?: string): PipelineNode => ({ id, type: 'anchor', prompt })
export const agent = (id: string, session: SessionTarget = 'new', prompt = `do ${id}`): PipelineNode => ({
  id,
  type: 'agent',
  session,
  prompt
})
export const say = (id: string, prompt = `say ${id}`): PipelineNode => ({ id, type: 'prompt', prompt })
export const join = (id: string): PipelineNode => ({ id, type: 'join' })

export const edge = (from: string, to: string, extra: Partial<PipelineEdge> = {}): PipelineEdge => ({
  id: `${from}->${to}`,
  from,
  to,
  ...extra
})
export const when = (from: string, to: string, condition: Condition, order?: number): PipelineEdge =>
  edge(from, to, { condition, order })
export const otherwise = (from: string, to: string): PipelineEdge => edge(from, to, { isDefault: true })

export const verdict = (value: string): Condition => ({ kind: 'output', path: 'json.verdict', op: 'eq', value })

export const graph = (nodes: PipelineNode[], edges: PipelineEdge[] = []): PipelineGraph => ({ nodes, edges })
