import { describe, expect, it } from 'vitest'
import { evaluate, globToRegExp } from './conditions'
import { render } from './template'
import type { StepOutput } from './types'

const step: StepOutput = {
  status: 'ok',
  output: 'Review done: 2 issues',
  json: { verdict: 'Fail', score: '4', issues: ['naming', 'tests'] },
  exitCode: 0,
  changedFiles: ['src/main/index.ts', 'docs/readme.md']
}

describe('conditions', () => {
  it('compares structured output leniently', () => {
    expect(evaluate({ kind: 'output', path: 'json.verdict', op: 'eq', value: 'fail' }, step)).toBe(true)
    expect(evaluate({ kind: 'output', path: 'json.score', op: 'gt', value: 3 }, step)).toBe(true)
    expect(evaluate({ kind: 'output', path: 'json.score', op: 'lt', value: 3 }, step)).toBe(false)
    expect(evaluate({ kind: 'output', path: 'json.issues', op: 'contains', value: 'tests' }, step)).toBe(true)
    expect(evaluate({ kind: 'output', path: 'output', op: 'matches', value: '\\d issues' }, step)).toBe(true)
    expect(evaluate({ kind: 'output', path: 'json.missing', op: 'exists' }, step)).toBe(false)
    expect(evaluate({ kind: 'output', path: 'exitCode', op: 'eq', value: 0 }, step)).toBe(true)
  })

  it('checks changed files, optionally by glob', () => {
    expect(evaluate({ kind: 'filesChanged' }, step)).toBe(true)
    expect(evaluate({ kind: 'filesChanged' }, { ...step, changedFiles: [] })).toBe(false)
    expect(evaluate({ kind: 'filesChanged', glob: 'src/**/*.ts' }, step)).toBe(true)
    expect(evaluate({ kind: 'filesChanged', glob: '*.md' }, step)).toBe(true)
    expect(evaluate({ kind: 'filesChanged', glob: 'src/*.ts' }, step)).toBe(false)
  })

  it('combines conditions', () => {
    const pass = { kind: 'output', path: 'json.verdict', op: 'eq', value: 'pass' } as const
    expect(evaluate({ kind: 'not', of: pass }, step)).toBe(true)
    expect(evaluate({ kind: 'all', of: [{ kind: 'status', equals: 'ok' }, pass] }, step)).toBe(false)
    expect(evaluate({ kind: 'any', of: [{ kind: 'status', equals: 'ok' }, pass] }, step)).toBe(true)
  })

  it('translates globs', () => {
    expect(globToRegExp('**/*.{ts,tsx}').test('a/b/c.tsx')).toBe(true)
    expect(globToRegExp('**/*.{ts,tsx}').test('c.ts')).toBe(true)
    expect(globToRegExp('src/?.ts').test('src/ab.ts')).toBe(false)
    expect(globToRegExp('a.b').test('axb')).toBe(false)
  })
})

describe('templates', () => {
  const scope = { input: 'add login', steps: { review: step } }

  it('fills the input and block outputs', () => {
    expect(render('{{ input }} / {{review}} / {{review.json.verdict}}', scope)).toBe('add login / Review done: 2 issues / Fail')
  })

  it('writes lists one per line and objects as JSON', () => {
    expect(render('{{review.json.issues}}', scope)).toBe('naming\ntests')
    expect(render('{{review.json}}', { input: '', steps: { review: { ...step, json: { a: 1 } } } })).toBe('{\n  "a": 1\n}')
  })

  it('leaves blocks that have not run empty', () => {
    expect(render('[{{later.output}}]', scope)).toBe('[]')
  })
})
