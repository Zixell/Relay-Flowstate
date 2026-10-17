import { describe, expect, it } from 'vitest'
import { stripShell } from './codex-chat'

describe('stripShell', () => {
  it('unwraps the login-shell wrapper Codex puts around commands', () => {
    expect(stripShell('/bin/zsh -lc ls')).toBe('ls')
    expect(stripShell(`/bin/zsh -lc "printf 'bye' > b.txt"`)).toBe("printf 'bye' > b.txt")
    expect(stripShell(`/bin/bash -c 'echo hi'`)).toBe('echo hi')
    expect(stripShell('/bin/zsh -lc "echo \\"q\\""')).toBe('echo "q"')
  })

  it('leaves plain commands alone', () => {
    expect(stripShell('git status')).toBe('git status')
  })
})
