import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.4.0', getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  shell: {}
}))
// As a dynamic import sees the CommonJS package: autoUpdater only on the default export
const fakeUpdater = { checkForUpdates: () => null }
vi.mock('electron-updater', () => ({ autoUpdater: undefined, default: { autoUpdater: fakeUpdater } }))
const { isNewer, winUpdater, describeUpdateError } = await import('./updater')

describe('describeUpdateError', () => {
  it('reads a release still being uploaded as such', () => {
    const err = new Error('Cannot find latest.yml in the latest release artifacts (https://…/latest.yml): HttpError: 404\n"method: GET…')
    expect(describeUpdateError(err)).toBe('The new version is still being published. Try again in a few minutes.')
  })

  it('keeps other errors to one short line', () => {
    expect(describeUpdateError(new Error('getaddrinfo ENOTFOUND api.github.com'))).toBe('No connection to GitHub. Check the network and try again.')
    expect(describeUpdateError(new Error('Something odd\n  at stack'))).toBe('Something odd')
  })
})

describe('winUpdater', () => {
  it('finds autoUpdater on the default export', async () => {
    expect(await winUpdater()).toBe(fakeUpdater)
  })
})

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
