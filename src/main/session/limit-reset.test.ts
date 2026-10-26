import { describe, expect, it } from 'vitest'
import { blockedResetAt, parseResetTime } from './limit-reset'

describe('parseResetTime', () => {
  // 2026-10-26 15:12 in Novosibirsk (UTC+7)
  const now = Date.UTC(2026, 9, 26, 8, 12)

  it('reads a time of day in the given zone', () => {
    const text = "You've hit your session limit · resets 10pm (Asia/Novosibirsk)"
    expect(parseResetTime(text, now)).toBe(Date.UTC(2026, 9, 26, 15, 0))
  })

  it('rolls over to tomorrow when the time has passed', () => {
    expect(parseResetTime('resets 9am (Asia/Novosibirsk)', now)).toBe(Date.UTC(2026, 9, 27, 2, 0))
  })

  it('understands minutes and 24-hour times', () => {
    expect(parseResetTime('resets 17:30 (Europe/Moscow)', now)).toBe(Date.UTC(2026, 9, 26, 14, 30))
    expect(parseResetTime('resets 12:15am (UTC)', now)).toBe(Date.UTC(2026, 9, 27, 0, 15))
  })

  it('gives up on text without a reset time or with an unknown zone', () => {
    expect(parseResetTime('Rate limited, try later', now)).toBeUndefined()
    expect(parseResetTime('resets 10pm (Mars/Olympus)', now)).toBeUndefined()
  })
})

describe('blockedResetAt', () => {
  const now = 1_000

  it('takes the earliest future reset of a used-up limit', () => {
    expect(
      blockedResetAt(
        [
          { label: '5-hour', status: 'blocked', resetsAt: 5_000 },
          { label: 'Weekly', usedPercent: 100, resetsAt: 3_000 },
          { label: 'Other', status: 'ok', resetsAt: 2_000 }
        ],
        now
      )
    ).toBe(3_000)
  })

  it('ignores limits that are not used up or already reset', () => {
    expect(blockedResetAt([{ label: '5-hour', status: 'warning', resetsAt: 5_000 }], now)).toBeUndefined()
    expect(blockedResetAt([{ label: '5-hour', status: 'blocked', resetsAt: 500 }], now)).toBeUndefined()
    expect(blockedResetAt(undefined, now)).toBeUndefined()
  })
})
