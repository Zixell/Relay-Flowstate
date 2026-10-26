import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.4.0', getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  shell: {}
}))
const { isNewer } = await import('./updater')

describe('isNewer', () => {
  it('compares versions part by part', () => {
    expect(isNewer('0.4.1', '0.4.0')).toBe(true)
    expect(isNewer('v0.5.0', '0.4.9')).toBe(true)
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('1.0', '0.9.9')).toBe(true)
  })

  it('does not offer the same or an older version', () => {
    expect(isNewer('0.4.0', '0.4.0')).toBe(false)
    expect(isNewer('v0.4.0', '0.4.0')).toBe(false)
    expect(isNewer('0.3.9', '0.4.0')).toBe(false)
    expect(isNewer('0.4.0-beta', '0.4.0')).toBe(false)
  })
})
