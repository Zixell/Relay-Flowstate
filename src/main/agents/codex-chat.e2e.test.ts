import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { codexChat } from './codex-chat'
import type { AgentEvent } from './adapter'

// Talks to the real Codex CLI and spends tokens: RELAY_E2E=1 npm test
describe.runIf(process.env.RELAY_E2E)('CodexAdapter (live)', () => {
  it('streams a turn, asks permission, edits a file, resumes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'relay-codex-e2e-'))
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd })
    writeFileSync(join(cwd, 'a.txt'), 'one\ntwo\nthree\n')
    execSync('git add . && git commit -qm init', { cwd })
    const events: AgentEvent[] = []
    const ctx = { taskId: 't', cwd, mode: 'untrusted', getBool: () => false }

    const session = codexChat.createSession(ctx)
    const done = new Promise<void>((resolve) =>
      session.onEvent((e) => {
        events.push(e)
        if (e.type === 'permission.requested') session.respondPermission(e.requestId, 'allow_once')
        if (e.type === 'turn.completed') resolve()
      })
    )
    await session.start()
    await session.send({
      text: 'Run `cat a.txt`. Then, using your apply_patch tool (not a shell command), change the line "two" to "TWO" in a.txt and create note.txt containing "ok". Reply "done".'
    })
    await done
    await session.dispose()
    console.log(JSON.stringify(events.filter((e) => e.type !== 'message.delta'), null, 1).slice(0, 6000))

    const types = events.map((e) => e.type)
    expect(types).toContain('session.started')
    expect(types).toContain('message.delta')
    expect(types).toContain('tool.started')
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'end_turn' })
    expect(existsSync(join(cwd, 'note.txt'))).toBe(true)

    const sessionId = (events.find((e) => e.type === 'session.started') as { sessionId: string }).sessionId
    const resumed = codexChat.createSession({ ...ctx, resumeSessionId: sessionId })
    let reply = ''
    const done2 = new Promise<void>((resolve) =>
      resumed.onEvent((e) => {
        if (e.type === 'message.completed') reply += e.text
        if (e.type === 'turn.completed') resolve()
      })
    )
    await resumed.start()
    await resumed.send({ text: 'Which new file did you just create? Answer with the file name only.' })
    await done2
    await resumed.dispose()
    expect(reply).toContain('note.txt')
  }, 240_000)
})
