import type { CompareOp, Condition, StepOutput } from './types'

/** Whether an arrow's condition holds for the output of the block it leaves. */
export function evaluate(condition: Condition, step: StepOutput): boolean {
  switch (condition.kind) {
    case 'status':
      return step.status === condition.equals
    case 'filesChanged': {
      const files = step.changedFiles ?? []
      if (!condition.glob) return files.length > 0
      const re = globToRegExp(condition.glob)
      const baseOnly = !condition.glob.includes('/')
      return files.some((f) => re.test(f) || (baseOnly && re.test(f.slice(f.lastIndexOf('/') + 1))))
    }
    case 'output':
      return compare(getPath(step, condition.path), condition.op, condition.value)
    case 'all':
      return condition.of.every((c) => evaluate(c, step))
    case 'any':
      return condition.of.some((c) => evaluate(c, step))
    case 'not':
      return !evaluate(condition.of, step)
  }
}

/** `a.b.0.c` into nested objects and arrays; undefined when any part is missing. */
export function getPath(value: unknown, path: string): unknown {
  let cur = value
  for (const part of path.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function compare(actual: unknown, op: CompareOp, expected: unknown): boolean {
  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== null
    case 'eq':
      return same(actual, expected)
    case 'neq':
      return !same(actual, expected)
    case 'contains':
      if (Array.isArray(actual)) return actual.some((x) => same(x, expected))
      return typeof actual === 'string' && actual.toLowerCase().includes(String(expected).toLowerCase())
    case 'matches':
      try {
        return actual !== undefined && new RegExp(String(expected), 'i').test(String(actual))
      } catch {
        return false
      }
    case 'gt':
    case 'lt': {
      const a = Number(actual)
      const b = Number(expected)
      if (actual === undefined || actual === null || Number.isNaN(a) || Number.isNaN(b)) return false
      return op === 'gt' ? a > b : a < b
    }
  }
}

/** Agents write `"3"` as often as `3`, and `"Pass"` as often as `"pass"` — compare scalars leniently. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a === null || b === null) return false
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  return String(a).toLowerCase() === String(b).toLowerCase()
}

/** `*` within a path segment, `**` across segments, `?` one character, `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      re += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end === -1) {
        re += '\\{'
        continue
      }
      re += '(?:' + glob.slice(i + 1, end).split(',').map(escape).join('|') + ')'
      i = end
    } else re += escape(c)
  }
  return new RegExp(`^${re}$`)
}

function escape(s: string): string {
  return s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
}
