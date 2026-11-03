import { describe, expect, it } from 'vitest'
import { rateLimitWindows, usageActivity, usageLimits } from './claude-chat'

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

describe('usage report', () => {
  it('lists the plan windows, per-model weekly ones too', () => {
    const limits = usageLimits({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 35, resets_at: '2026-11-03T11:40:00Z' },
        seven_day: { utilization: 85, resets_at: null },
        seven_day_opus: null,
        model_scoped: [{ display_name: 'Fable', utilization: 0, resets_at: null }]
      }
    })
    expect(limits).toEqual([
      { label: '5-hour', usedPercent: 35, resetsAt: Date.parse('2026-11-03T11:40:00Z'), status: 'ok' },
      { label: 'Weekly', usedPercent: 85, resetsAt: undefined, status: 'warning' },
      { label: 'Weekly Fable', usedPercent: 0, resetsAt: undefined, status: 'ok' }
    ])
  })

  it('has no limits for an API-key sign-in', () => {
    expect(usageLimits({ rate_limits_available: false, rate_limits: null })).toBeNull()
  })

  it('turns a period into tips and top items', () => {
    const a = usageActivity('Last 24 hours', {
      request_count: 456,
      session_count: 8,
      behaviors: [{ key: 'long_context', pct: 93, count: 341 }],
      recommendations: [{ pct: 93, title: 'Start fresh when you switch tasks', detail: 'run /clear' }],
      agents: [],
      skills: [{ name: 'run', pct: 1 }],
      plugins: [],
      mcp_servers: [{ name: 'gitlab-review', pct: 1 }]
    })
    expect(a).toEqual({
      label: 'Last 24 hours',
      requests: 456,
      sessions: 8,
      tips: [{ pct: 93, title: 'Start fresh when you switch tasks', detail: 'run /clear' }],
      top: [
        { label: 'Skills', items: [{ name: 'run', pct: 1 }] },
        { label: 'MCP servers', items: [{ name: 'gitlab-review', pct: 1 }] }
      ]
    })
  })
})

