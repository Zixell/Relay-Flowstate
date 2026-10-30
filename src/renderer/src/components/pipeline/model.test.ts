import { describe, expect, it } from 'vitest'
import { edgeLabel, freeId, layout, newBlock, renameBlock } from './model'
import type { PipelineGraph } from '../../../../main/pipeline/types'

describe('pipeline editor model', () => {
  it('picks readable ids that are free', () => {
    expect(freeId('agent', ['anchor'])).toBe('agent')
    expect(freeId('agent', ['agent', 'agent2'])).toBe('agent3')
    expect(newBlock('commit', [], { x: 0, y: 0 })).toMatchObject({ id: 'commit', type: 'action', action: 'commit' })
  })

  it('renames a block in arrows, loop exits and templates', () => {
    const g: PipelineGraph = {
      nodes: [
        { id: 'anchor', type: 'anchor', prompt: '{{input}} {{agent.output}}' },
        { id: 'agent', type: 'agent', session: 'new', prompt: 'x' },
        { id: 'fix', type: 'prompt', prompt: 'Fix {{agent.json.issues}} not {{agent2.output}} or {{ agent }}' }
      ],
      edges: [
        { id: 'e1', from: 'anchor', to: 'agent' },
        { id: 'e2', from: 'fix', to: 'agent', maxIterations: 2, onExhausted: { kind: 'goto', nodeId: 'agent' } }
      ]
    }
    const r = renameBlock(g, 'agent', 'review')
    expect(r.nodes.map((n) => n.id)).toEqual(['anchor', 'review', 'fix'])
    expect(r.edges).toMatchObject([
      { from: 'anchor', to: 'review' },
      { from: 'fix', to: 'review', onExhausted: { nodeId: 'review' } }
    ])
    expect((r.nodes[0] as { prompt: string }).prompt).toBe('{{input}} {{review.output}}')
    expect((r.nodes[2] as { prompt: string }).prompt).toBe('Fix {{review.json.issues}} not {{agent2.output}} or {{review }}')
  })

  it('labels arrows with their condition and loop limit', () => {
    expect(edgeLabel({ id: 'e', from: 'a', to: 'b', order: 1, condition: { kind: 'output', path: 'json.verdict', op: 'eq', value: 'pass' } }, false)).toBe(
      '1. verdict = pass'
    )
    expect(edgeLabel({ id: 'e', from: 'a', to: 'b', isDefault: true }, false)).toBe('else')
    expect(edgeLabel({ id: 'e', from: 'a', to: 'b' }, true)).toBe('↻ set a limit')
    expect(edgeLabel({ id: 'e', from: 'a', to: 'b', maxIterations: 3 }, true)).toBe('↻ ≤3')
  })

  it('lays out blocks without positions in columns from the start', () => {
    const g = layout({
      nodes: [
        { id: 'anchor', type: 'anchor' },
        { id: 'a', type: 'prompt', prompt: 'x' },
        { id: 'b', type: 'prompt', prompt: 'y' }
      ],
      edges: [
        { id: 'e1', from: 'anchor', to: 'a' },
        { id: 'e2', from: 'anchor', to: 'b' }
      ]
    })
    expect(g.nodes.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 150 }
    ])
  })
})
