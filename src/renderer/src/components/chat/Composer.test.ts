import { describe, expect, it } from 'vitest'
import { matchCommands } from './Composer'

const cmds = ['postman:api-testing', 'compact', 'review', 'postman:compare', 'clear', 'my-plugin:commit'].map((name) => ({ name }))

describe('matchCommands', () => {
  it('puts plain commands before plugin commands', () => {
    expect(matchCommands(cmds, '').map((c) => c.name).slice(0, 3)).toEqual(['compact', 'review', 'clear'])
  })

  it('ranks prefix matches, then plugin commands by their own name, then substrings', () => {
    expect(matchCommands(cmds, 'com').map((c) => c.name)).toEqual(['compact', 'postman:compare', 'my-plugin:commit'])
    expect(matchCommands(cmds, 'view').map((c) => c.name)).toEqual(['review'])
  })
})
