import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings = new Map<string, string>()
let read: (() => Promise<unknown>) | undefined

vi.mock('../settings', () => ({
  getSetting: (key: string) => settings.get(key) ?? '',
  setSetting: (key: string, value: string) => settings.set(key, value)
}))
vi.mock('../agents', () => ({ getAgent: () => ({ chat: read ? { readLimits: read } : {} }) }))

const { getAccountLimits, recordLimits, refreshLimits } = await import('./account-limits')

describe('account limits', () => {
  beforeEach(() => {
    settings.clear()
    read = undefined
  })

  it('merges what chats report, window by window', () => {
    recordLimits('claude-code', [{ label: '5-hour', usedPercent: 10 }, { label: 'Weekly', usedPercent: 3 }])
    recordLimits('claude-code', [{ label: '5-hour', usedPercent: 40 }])
    expect(getAccountLimits()['claude-code'].limits).toEqual([
      { label: '5-hour', usedPercent: 40 },
      { label: 'Weekly', usedPercent: 3 }
    ])
  })

  it('replaces them with what the CLI says on refresh', async () => {
    recordLimits('codex', [{ label: '5-hour', usedPercent: 10 }, { label: 'Weekly', usedPercent: 3 }])
    read = async () => [{ label: 'Weekly', usedPercent: 5 }]
    expect((await refreshLimits('codex'))?.limits).toEqual([{ label: 'Weekly', usedPercent: 5 }])
    expect(getAccountLimits().codex.limits).toEqual([{ label: 'Weekly', usedPercent: 5 }])
  })

  it('keeps the last values when the CLI cannot tell', async () => {
    recordLimits('codex', [{ label: '5-hour', usedPercent: 10 }])
    read = async () => {
      throw new Error('offline')
    }
    expect(await refreshLimits('codex')).toBeNull()
    expect(getAccountLimits().codex.limits).toEqual([{ label: '5-hour', usedPercent: 10 }])
  })
})
