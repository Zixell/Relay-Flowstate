import { describe, expect, it } from 'vitest'
import type { AgentEvent, SessionSettings } from './adapter'
import { claudeChat } from './claude-chat'

type Testable = {
  onEvent: (cb: (e: AgentEvent) => void) => void
  replay: (msg: unknown) => void
  applySessionSettings: (changes: Record<string, string | boolean | null>) => Promise<void>
}

const session = (sessionSettings?: SessionSettings): Testable =>
  claudeChat.createSession({ taskId: 't', cwd: '/repo', getSetting: () => '', sessionSettings }) as unknown as Testable

const suggestion = { type: 'prompt_suggestion', suggestion: 'Run the tests', uuid: 'u', session_id: 's' }

describe('Claude session settings', () => {
  it('declares the chat /config settings', () => {
    const keys = claudeChat.capabilities.sessionSettings?.map((d) => d.key)
    expect(keys).toEqual(['alwaysThinkingEnabled', 'effortLevel', 'outputStyle', 'autoCompactEnabled', 'language', 'promptSuggestions'])
  })

  it('drops next-message suggestions when turned off, live', async () => {
    const s = session()
    const seen: string[] = []
    s.onEvent((e) => {
      if (e.type === 'prompt.suggested') seen.push(e.text)
    })
    s.replay(suggestion)
    await s.applySessionSettings({ promptSuggestions: false })
    s.replay(suggestion)
    await s.applySessionSettings({ promptSuggestions: null })
    s.replay(suggestion)
    expect(seen).toEqual(['Run the tests', 'Run the tests'])
  })

  it('starts with suggestions off when the task says so', () => {
    const s = session({ promptSuggestions: false })
    const seen: string[] = []
    s.onEvent((e) => {
      if (e.type === 'prompt.suggested') seen.push(e.text)
    })
    s.replay(suggestion)
    expect(seen).toEqual([])
  })
})
