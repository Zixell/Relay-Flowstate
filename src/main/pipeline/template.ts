import { getPath } from './conditions'
import type { StepOutput } from './types'

export interface TemplateScope {
  /** The user's message. */
  input: string
  /** Latest output of every block that has run, by block id. */
  steps: Record<string, StepOutput>
}

/**
 * Fills `{{input}}`, `{{<block>}}` (its text) and `{{<block>.<path>}}` — e.g. `{{review.output}}`,
 * `{{review.json.issues}}`, `{{anchor.changedFiles}}`. A block that has not run
 * yet gives an empty string; objects and arrays are written as JSON, lists of
 * strings one per line.
 */
export function render(template: string, scope: TemplateScope): string {
  return template.replace(/\{\{\s*([\w-]+)((?:\.[\w-]+)*)\s*\}\}/g, (_, head: string, rest: string) => {
    if (!rest) return head === 'input' ? scope.input : format(scope.steps[head]?.output)
    return format(getPath(scope.steps[head], rest.slice(1)))
  })
}

function format(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join('\n')
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}
