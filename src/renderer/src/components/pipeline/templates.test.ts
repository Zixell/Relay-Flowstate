import { describe, expect, it } from 'vitest'
import { validate } from '../../../../main/pipeline/validate'
import { TEMPLATES } from './templates'

describe('pipeline templates', () => {
  it.each(TEMPLATES.map((t) => [t.name, t] as const))('%s is a valid pipeline without warnings', (_, t) => {
    expect(validate(t.graph).issues).toEqual([])
    expect(t.graph.nodes.every((n) => n.position)).toBe(true)
  })

  it('have unique ids', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length)
  })
})
