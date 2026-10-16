import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeChat } from './claude-chat'
import type { AgentEvent } from './adapter'

// Talks to the real Claude Code CLI and spends tokens: RELAY_E2E=1 npm test
describe.runIf(process.env.RELAY_E2E)('ClaudeAdapter (live)', () => {
  it('streams a turn, asks permission, resumes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'relay-e2e-'))
    execSync('git init -q', { cwd })
    const events: AgentEvent[] = []
    const ctx = { taskId: 't', cwd, mode: 'default', getBool: () => false }

    const session = claudeChat.createSession(ctx)
    const done = new Promise<void>((resolve) =>
      session.onEvent((e) => {
        events.push(e)
        if (e.type === 'permission.requested') session.respondPermission(e.requestId, 'allow_once')
        if (e.type === 'turn.completed') resolve()
      })
    )
    await session.start()
    await session.send({ text: 'Create note.txt containing "ok" using the Write tool, then reply "done".' })
    await done
    await session.dispose()

    const types = events.map((e) => e.type)
    expect(types).toContain('session.started')
    expect(types).toContain('message.delta')
    expect(types).toContain('permission.requested')
    const tool = events.find((e) => e.type === 'tool.completed')
    expect(tool && tool.type === 'tool.completed' && tool.status).toBe('ok')
    expect(tool && tool.type === 'tool.completed' && tool.diff?.[0].newText).toContain('ok')
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'end_turn' })
    expect(existsSync(join(cwd, 'note.txt'))).toBe(true)

    // Resume the same conversation in a new process.
    const sessionId = (events.find((e) => e.type === 'session.started') as { sessionId: string }).sessionId
    const resumed = claudeChat.createSession({ ...ctx, resumeSessionId: sessionId })
    let reply = ''
    const done2 = new Promise<void>((resolve) =>
      resumed.onEvent((e) => {
        if (e.type === 'message.completed') reply += e.text
        if (e.type === 'turn.completed') resolve()
      })
    )
    await resumed.start()
    await resumed.send({ text: 'Which file did you just create? Answer with the file name only.' })
    await done2
    await resumed.dispose()
    expect(reply).toContain('note.txt')
  }, 180_000)
})
