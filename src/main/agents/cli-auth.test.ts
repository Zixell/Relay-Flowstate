import { describe, expect, it } from 'vitest'
import { parsePastedCode } from './cli-auth'

describe('parsePastedCode', () => {
  it('takes a bare code as is', () => {
    expect(parsePastedCode('  abc123#xyz \n')).toEqual({ code: 'abc123#xyz' })
  })

  it('reads code and state from the address the browser was sent back to', () => {
    expect(parsePastedCode('http://127.0.0.1:1455/auth/callback?code=ac_1-2&scope=x&state=St4te')).toEqual({ code: 'ac_1-2', state: 'St4te' })
    expect(parsePastedCode('http://localhost:64041/callback?code=c0de')).toEqual({ code: 'c0de', state: undefined })
  })

  it('does not mistake an address without a code for one', () => {
    expect(parsePastedCode('https://claude.com/oauth')).toEqual({ code: 'https://claude.com/oauth' })
  })
})
