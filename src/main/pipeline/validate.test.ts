import { describe, expect, it } from 'vitest'
import { agent, anchor, edge, graph, join, otherwise, say, verdict, when } from './__fixtures__/graphs'
import { validate, type ValidationIssue } from './validate'
import type { PipelineGraph } from './types'

const codes = (g: PipelineGraph): string[] => validate(g).issues.map((i) => i.code)
const issue = (g: PipelineGraph, code: string): ValidationIssue | undefined => validate(g).issues.find((i) => i.code === code)

describe('validate', () => {
  it('accepts the bare anchor', () => {
    expect(validate(graph([anchor()])).ok).toBe(true)
  })

  it('requires exactly one anchor', () => {
    expect(codes(graph([agent('a')]))).toContain('anchor-count')
    expect(codes(graph([anchor('x'), anchor('y')]))).toContain('anchor-count')
  })

  it('reports blocks that are not connected', () => {
    const g = graph([anchor(), agent('a'), agent('lost'), agent('after')], [edge('anchor', 'a'), edge('lost', 'after')])
    expect(issue(g, 'unreachable')?.nodeIds).toEqual(['lost', 'after'])
  })

  it('reports two chains leading into the anchor', () => {
    const g = graph([agent('p1'), agent('p2'), anchor()], [edge('p1', 'anchor'), edge('p2', 'anchor')])
    expect(issue(g, 'multiple-entries')?.nodeIds).toEqual(['p1', 'p2'])
  })

  it('highlights a cycle until it has a limit', () => {
    const loop = (max?: number): PipelineGraph =>
      graph(
        [anchor(), agent('review'), say('fix'), agent('commit')],
        [
          edge('anchor', 'review'),
          when('review', 'commit', verdict('pass')),
          otherwise('review', 'fix'),
          edge('fix', 'review', { maxIterations: max })
        ]
      )
    const bad = issue(loop(), 'loop-limit')
    expect(bad?.edgeIds).toEqual(['fix->review'])
    expect(bad?.nodeIds?.sort()).toEqual(['fix', 'review'])
    expect(validate(loop(3)).ok).toBe(true)
  })

  it('finds the back-arrow from the entry, also for a loop into the anchor', () => {
    const g = graph([anchor(), agent('check')], [edge('anchor', 'check'), edge('check', 'anchor')])
    expect(issue(g, 'loop-limit')?.edgeIds).toEqual(['check->anchor'])
  })

  it('refuses an exhausted loop that goes back into itself', () => {
    const g = graph(
      [anchor(), agent('a'), agent('b')],
      [edge('anchor', 'a'), edge('a', 'b'), edge('b', 'a', { maxIterations: 2, onExhausted: { kind: 'goto', nodeId: 'a' } })]
    )
    expect(codes(g)).toContain('exhausted-target')
  })

  it('needs a default next to conditional arrows', () => {
    const g = graph([anchor(), agent('a'), agent('b')], [when('anchor', 'a', verdict('pass')), edge('anchor', 'b')])
    expect(issue(g, 'missing-default')?.nodeIds).toEqual(['anchor'])
    const lone = graph([anchor(), agent('a')], [otherwise('anchor', 'a')])
    expect(codes(lone)).toContain('default-without-conditions')
  })

  it('keeps blocks before the anchor out of the current session', () => {
    const ok = graph([agent('enrich', 'new'), anchor()], [edge('enrich', 'anchor')])
    expect(validate(ok).ok).toBe(true)
    expect([...validate(ok).analysis.preNodes]).toEqual(['enrich'])
    const bad = graph([agent('enrich', 'current'), anchor()], [edge('enrich', 'anchor')])
    expect(issue(bad, 'pre-current-session')?.nodeIds).toEqual(['enrich'])
  })

  it('refuses parallel branches that both use the current session', () => {
    const g = graph([anchor(), say('a'), agent('b', 'current')], [edge('anchor', 'a'), edge('anchor', 'b')])
    expect(issue(g, 'parallel-current-session')?.nodeIds?.sort()).toEqual(['a', 'b'])
    const fine = graph([anchor(), say('a'), agent('b', 'new')], [edge('anchor', 'a'), edge('anchor', 'b')])
    expect(validate(fine).ok).toBe(true)
  })

  it('does not take if/else branches for parallel ones', () => {
    const g = graph(
      [anchor(), agent('review'), say('commit'), say('fix')],
      [edge('anchor', 'review'), when('review', 'commit', verdict('pass')), otherwise('review', 'fix')]
    )
    expect(validate(g).issues).toEqual([])
  })

  it('warns when parallel branches meet without a Join', () => {
    const nodes = [anchor(), agent('push'), agent('docs'), agent('notify')]
    const merged = graph(nodes, [edge('anchor', 'push'), edge('anchor', 'docs'), edge('push', 'notify'), edge('docs', 'notify')])
    expect(issue(merged, 'parallel-merge')?.nodeIds).toEqual(['notify'])

    const joined = graph(
      [...nodes, join('both')],
      [edge('anchor', 'push'), edge('anchor', 'docs'), edge('push', 'both'), edge('docs', 'both'), edge('both', 'notify')]
    )
    expect(validate(joined).issues).toEqual([])
  })

  it('checks the budget', () => {
    expect(codes({ ...graph([anchor()]), budget: { maxTurns: 0 } })).toContain('budget')
    expect(codes({ ...graph([anchor()]), budget: { maxCostUsd: -1 } })).toContain('budget')
    expect(validate({ ...graph([anchor()]), budget: { maxTurns: 10, maxCostUsd: 2.5 } }).ok).toBe(true)
  })

  it('checks the settings a block cannot run without', () => {
    expect(issue(graph([anchor(), agent('a', 'new', ' ')], [edge('anchor', 'a')]), 'node-config')?.nodeIds).toEqual(['a'])
  })
})
