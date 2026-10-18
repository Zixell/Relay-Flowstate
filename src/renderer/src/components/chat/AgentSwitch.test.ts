import { describe, expect, it } from 'vitest'
import { hitUsageLimit } from './AgentSwitch'

describe('hitUsageLimit', () => {
  it('recognizes limit errors from the agents', () => {
    expect(hitUsageLimit("Claude AI usage limit reached|1792281600", undefined)).toBe(true)
    expect(hitUsageLimit('You have hit your usage limit. Upgrade to Pro or try again later.', undefined)).toBe(true)
    expect(hitUsageLimit('429 Too Many Requests: rate_limit_error', undefined)).toBe(true)
    expect(hitUsageLimit('Insufficient credits', undefined)).toBe(true)
  })

  it('recognizes an exhausted plan limit without an error message', () => {
    expect(hitUsageLimit(null, [{ status: 'ok' }, { status: 'blocked' }])).toBe(true)
  })

  it('stays quiet for other failures', () => {
    expect(hitUsageLimit('ENOENT: no such file or directory', [{ status: 'warning' }])).toBe(false)
    expect(hitUsageLimit(null, undefined)).toBe(false)
  })
})
