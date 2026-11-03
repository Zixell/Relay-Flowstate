import { describe, expect, it } from 'vitest'
import { rateLimitWindows } from './claude-chat'

describe('rateLimitWindows', () => {
  it('reads every window a current CLI reports', () => {
    // As Claude Code 2.1.3xx sends it: no top-level utilization
    const info = {
      status: 'allowed' as const,
      resetsAt: 1793706000,
      rateLimitType: 'five_hour' as const,
      unifiedWindows: {
        five_hour: { utilization: 0.31, resetsAt: 1793706000, status: 'allowed' },
        seven_day: { utilization: 0.28, resetsAt: 1793710800, status: 'allowed' }
      }
    }
    expect(rateLimitWindows(info)).toEqual([
      { label: '5-hour', usedPercent: 31, resetsAt: 1793706000000, status: 'ok' },
      { label: 'Weekly', usedPercent: 28, resetsAt: 1793710800000, status: 'ok' }
    ])
  })

  it('falls back to the top-level window of an older CLI', () => {
    expect(rateLimitWindows({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.85, resetsAt: 100 })).toEqual([
      { label: 'Weekly', usedPercent: 85, resetsAt: 100000, status: 'warning' }
    ])
  })

  it('marks a used-up window as blocked', () => {
    const [w] = rateLimitWindows({ status: 'rejected', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1, status: 'rejected' } } } as never)
    expect(w.status).toBe('blocked')
  })
})
