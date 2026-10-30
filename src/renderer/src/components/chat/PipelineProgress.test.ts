import { describe, expect, it } from 'vitest'
import { columns } from './PipelineProgress'

describe('pipeline progress columns', () => {
  it('stacks steps that ran at the same time, one after another goes to the next column', () => {
    const steps = [
      { id: 'anchor', startedAt: 0, endedAt: 10 },
      { id: 'push', startedAt: 10, endedAt: 20 },
      { id: 'docs', startedAt: 10, endedAt: 15 },
      { id: 'join', startedAt: 20, endedAt: 20 },
      { id: 'review', startedAt: 21 }
    ]
    expect(columns(steps).map((c) => c.map((s) => s.id))).toEqual([['anchor'], ['push', 'docs'], ['join'], ['review']])
  })
})

describe('pipeline run usage', () => {
  it('counts agent turns and cost against the budget', async () => {
    const { usage } = await import('./PipelineProgress')
    const step = (nodeId: string, costUsd?: number) => ({ id: nodeId, nodeId, activation: 0, status: 'ok' as const, startedAt: 0, output: { status: 'ok' as const, output: '', costUsd } })
    const view = {
      id: 'r',
      name: 'p',
      input: '',
      status: 'running' as const,
      error: null,
      graph: {
        nodes: [
          { id: 'anchor', type: 'anchor' as const },
          { id: 'review', type: 'agent' as const, session: 'new' as const, prompt: 'x' },
          { id: 'sh', type: 'action' as const, action: 'shell' as const, command: 'x' }
        ],
        edges: [],
        budget: { maxTurns: 10, maxCostUsd: 2 }
      },
      steps: [step('anchor', 0.3), step('review', 0.12), step('sh')]
    }
    expect(usage(view)).toBe('2/10 turns · $0.42 of $2')
    expect(usage({ ...view, graph: { ...view.graph, budget: undefined }, steps: [step('anchor')] })).toBe('1 turn')
  })
})
