import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, realpathSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { createAcpChat } from './acp-chat'
import type { AgentEvent } from './adapter'

// Talks to a real ACP agent and may spend tokens:
//   RELAY_E2E=1 RELAY_ACP_BIN=/path/to/agent RELAY_ACP_ARGS="--acp" npx vitest run src/main/agents/acp-chat.e2e.test.ts
describe.runIf(process.env.RELAY_E2E && process.env.RELAY_ACP_BIN)('AcpAdapter (live)', () => {
  it('runs a turn with a permission prompt and resumes the session', async () => {
    const chat = createAcpChat({
      id: 'e2e-acp',
      binary: process.env.RELAY_ACP_BIN!,
      args: (process.env.RELAY_ACP_ARGS ?? '').split(' ').filter(Boolean),
      loginHint: 'Sign in first.'
    })
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'relay-acp-e2e-')))
    execSync('git init -q', { cwd })
    const events: AgentEvent[] = []
    const ctx = { taskId: 't', cwd, getBool: () => false }

    const session = chat.createSession(ctx)
    const done = new Promise<void>((resolve) =>
      session.onEvent((e) => {
        events.push(e)
        if (e.type === 'permission.requested') session.respondPermission(e.requestId, 'allow_once')
        if (e.type === 'turn.completed') resolve()
      })
    )
    await session.start()
    await session.send({ text: 'Create note.txt containing "ok" using your file writing tool, then reply "done". Remember the word ORCHID.' })
    await done
    await session.dispose()
    console.log(JSON.stringify(events.filter((e) => e.type !== 'message.delta'), null, 1).slice(0, 5000))

    expect(events[0].type).toBe('session.started')
    expect(events.some((e) => e.type === 'tool.started')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'end_turn' })
    expect(existsSync(join(cwd, 'note.txt'))).toBe(true)

    const sessionId = (events[0] as { sessionId: string }).sessionId
    const resumed = chat.createSession({ ...ctx, resumeSessionId: sessionId })
    let reply = ''
    const done2 = new Promise<void>((resolve) =>
      resumed.onEvent((e) => {
        if (e.type === 'message.completed') reply += e.text
        if (e.type === 'turn.completed') resolve()
      })
    )
    await resumed.start()
    await resumed.send({ text: 'Which word did I ask you to remember? One word.' })
    await done2
    await resumed.dispose()
    expect(reply).toMatch(/ORCHID/i)
  }, 300_000)
})
