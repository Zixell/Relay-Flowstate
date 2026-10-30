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
