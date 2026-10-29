import { describe, expect, it } from 'vitest'
import { needsSignIn } from './SignInBanner'

const reply = (content: string) => ({ kind: 'text' as const, role: 'assistant' as const, content })

describe('needsSignIn', () => {
  it('recognizes the agents asking to sign in', () => {
    expect(needsSignIn(reply('Not logged in · Please run /login'))).toBe(true)
    expect(needsSignIn(reply('Failed to authenticate: OAuth session expired and could not be refreshed'))).toBe(true)
    expect(needsSignIn(reply("/login isn't available in this environment."))).toBe(true)
    expect(needsSignIn({ kind: 'error', role: 'system', content: 'unexpected status 401 Unauthorized' })).toBe(true)
    expect(needsSignIn({ kind: 'error', role: 'system', content: 'Authentication required. Run `codex login`.' })).toBe(true)
  })

  it('stays quiet for other endings', () => {
    expect(needsSignIn(reply('Done — the tests pass.'))).toBe(false)
    expect(needsSignIn({ kind: 'text', role: 'user', content: '/login' })).toBe(false)
    expect(needsSignIn(reply(`The handler now returns 401 for an expired token. ${'More detail. '.repeat(30)}`))).toBe(false)
    expect(needsSignIn(undefined)).toBe(false)
  })
})
