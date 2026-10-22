import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { createAcpChat } from './acp-chat'
import type { AgentEvent } from './adapter'

const chat = createAcpChat({
  id: 'mock-acp',
  binary: join(__dirname, '__fixtures__', 'mock-acp-agent.cjs'),
  args: [],
  loginHint: 'Sign in.'
})
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'relay-acp-')))
const ctx = { taskId: 't', cwd, getSetting: () => '' }

function run(session: ReturnType<typeof chat.createSession>, respond: string) {
  const events: AgentEvent[] = []
  const done = new Promise<void>((resolve) =>
    session.onEvent((e) => {
      events.push(e)
      if (e.type === 'permission.requested') session.respondPermission(e.requestId, respond)
      if (e.type === 'turn.completed') resolve()
    })
  )
  return { events, done }
}

describe('ACP adapter', () => {
  it('maps a turn: thought, refined tool call, permission, diff, plan, streamed reply', async () => {
    const session = chat.createSession(ctx)
    const { events, done } = run(session, 'allow_once')
    await session.start()
    await session.send({ text: 'make hi.txt' })
    await done
    await session.dispose()

    expect(events[0]).toMatchObject({ type: 'session.started', sessionId: 'sess-1', mode: 'default' })
    expect(events.find((e) => e.type === 'thinking')).toMatchObject({ text: 'Thinking it over' })
    // The placeholder call is held back until its arguments arrive.
    const started = events.filter((e) => e.type === 'tool.started')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ toolCallId: 't1', kind: 'edit', title: 'hi.txt' })
    const perm = events.find((e) => e.type === 'permission.requested')
    expect(perm && perm.type === 'permission.requested' && perm.options.map((o) => o.id)).toEqual(['allow_once', 'allow_always', 'deny'])
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({
      status: 'ok',
      output: 'File created',
      diff: [{ path: 'hi.txt', oldText: '', newText: 'hi' }]
    })
    expect(events.find((e) => e.type === 'plan.updated')).toMatchObject({ items: [{ text: 'Write the file', status: 'done' }] })
    expect(events.filter((e) => e.type === 'message.delta').map((e) => (e as { text: string }).text).join('')).toBe('Created hi.txt.')
    expect(events.find((e) => e.type === 'message.completed')).toMatchObject({ text: 'Created hi.txt.' })
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'end_turn', usage: { inputTokens: 5, outputTokens: 7, costUsd: 0.25 } })

    // Modes and models the agent offered are now in the capabilities.
    expect(chat.capabilities.modes?.map((m) => m.id)).toEqual(['default', 'auto'])
    expect(chat.capabilities.models?.map((m) => m.id)).toEqual(['default', 'm1', 'm2'])
  })

  it('a denied call ends as an error', async () => {
    const session = chat.createSession(ctx)
    const { events, done } = run(session, 'deny')
    await session.start()
    await session.send({ text: 'make hi.txt' })
    await done
    await session.dispose()
    expect(events.find((e) => e.type === 'tool.completed')).toMatchObject({ status: 'error', output: 'Denied' })
  })

  it('lists, replays and forks saved sessions', async () => {
    const history = chat.history!
    const listed = await history.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ sessionId: 'old-sess', title: 'Old chat', updatedAt: Date.parse('2026-10-01T10:00:00Z') })
    const entries = await history.load('old-sess', cwd)
    expect(entries[0]).toEqual({ type: 'user', text: 'Earlier question', images: [] })
    const kinds = entries.map((e) => (e.type === 'user' ? 'user' : e.event.type))
    expect(kinds).toEqual(['user', 'message.delta', 'message.completed', 'tool.started', 'tool.completed'])
    expect(await history.fork('old-sess', cwd)).toBe('forked-old-sess')
  })
})
