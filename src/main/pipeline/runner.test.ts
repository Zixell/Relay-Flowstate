import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSession } from '../agents/adapter'
import type { StepContext } from './engine'
import { createRunner, extractJson, type RunnerDeps, type TurnOutcome } from './runner'
import type { PipelineNode } from './types'

const ctx = (steps: StepContext['steps'] = {}): StepContext => ({ runId: 'r', stepId: 'r:n:0', input: 'add login', steps, activation: 0 })
const signal = (): AbortSignal => new AbortController().signal

/** A session that answers every prompt with `reply`, or waits when `reply` is null. */
function fakeSession(reply: AgentEvent[] | null) {
  const listeners = new Set<(e: AgentEvent) => void>()
  const emit = (e: AgentEvent): void => listeners.forEach((l) => l(e))
  const session = {
    sent: [] as string[],
    disposed: false,
    start: vi.fn(async () => emit({ type: 'session.started', sessionId: 'side-1' })),
    send: vi.fn(async (input: { text: string }) => {
      session.sent.push(input.text)
      if (reply) setTimeout(() => reply.forEach(emit), 0)
    }),
    interrupt: vi.fn(async () => {}),
    respondPermission: vi.fn(),
    dispose: vi.fn(async () => {
      session.disposed = true
    }),
    onEvent: (cb: (e: AgentEvent) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
  return session
}

function deps(over: Partial<RunnerDeps> = {}): RunnerDeps & { turns: { text: string; show: boolean }[]; side: AgentEvent[] } {
  const turns: { text: string; show: boolean }[] = []
  const side: AgentEvent[] = []
  return {
    agentId: 'claude-code',
    cwd: process.cwd(),
    turns,
    side,
    runTurn: async (input, opts): Promise<TurnOutcome> => {
      turns.push({ text: input.text, show: opts.show })
      return { reason: 'end_turn', texts: ['Done'], changedFiles: ['a.ts'] }
    },
    openSession: () => fakeSession([]) as unknown as AgentSession,
    onSideEvent: (_s, e) => side.push(e),
    onSideClosed: () => {},
    snapshot: (label) => label,
    changedFiles: (from, to) => [`${from}..${to}`],
    commit: (message) => ({ status: 'ok', output: message }),
    notify: () => {},
    ...over
  }
}

const reviewer: PipelineNode = {
  id: 'review',
  type: 'agent',
  session: 'new',
  prompt: 'Review it',
  outputSchema: { type: 'object', properties: { verdict: { enum: ['pass', 'fail'] } } }
}

describe('runner', () => {
  it('sends the anchor quietly and pipeline prompts visibly to the task session', async () => {
    const d = deps({ images: [{ mediaType: 'image/png', data: 'x' }] })
    const runner = createRunner(d)
    const anchor = await runner.run({ id: 'anchor', type: 'anchor', prompt: 'add login' }, ctx(), signal())
    await runner.run({ id: 'fix', type: 'prompt', prompt: 'Fix it' }, ctx(), signal())
    expect(d.turns).toEqual([
      { text: 'add login', show: false },
      { text: 'Fix it', show: true }
    ])
    expect(anchor).toMatchObject({ status: 'ok', output: 'Done', changedFiles: ['a.ts'] })
  })

  it('turns an interrupted or failed turn into a failed step', async () => {
    const d = deps({ runTurn: async () => ({ reason: 'interrupted', texts: [], changedFiles: [] }) })
    expect(await createRunner(d).run({ id: 'a', type: 'prompt', prompt: 'x' }, ctx(), signal())).toMatchObject({
      status: 'error',
      error: 'Interrupted'
    })
  })

  it('runs a new-session step to the end of its turn and reads its JSON', async () => {
    const session = fakeSession([
      { type: 'turn.started', turnId: 't' },
      { type: 'permission.requested', requestId: 'p1', title: 'Run tests?', options: [] },
      { type: 'message.completed', messageId: 'm', text: 'Looks fine.\n```json\n{"verdict":"pass"}\n```' },
      { type: 'turn.completed', turnId: 't', reason: 'end_turn' }
    ])
    const closed = vi.fn()
    const d = deps({ openSession: () => session as unknown as AgentSession, onSideClosed: closed })
    const out = await createRunner(d).run(reviewer, ctx(), signal())
    expect(out).toMatchObject({ status: 'ok', json: { verdict: 'pass' }, sessionId: 'side-1' })
    expect(out.changedFiles).toEqual(['pipeline-r-n-0-before..pipeline-r-n-0-after'])
    expect(session.sent[0]).toMatch(/^Review it\n\nEnd your answer with a JSON object/)
    expect(d.side.map((e) => e.type)).toContain('permission.requested')
    expect(session.disposed).toBe(true)
    expect(closed).toHaveBeenCalledOnce()
  })

  it('fails a step that declared a schema but gave no JSON', async () => {
    const session = fakeSession([
      { type: 'message.completed', messageId: 'm', text: 'All good' },
      { type: 'turn.completed', turnId: 't', reason: 'end_turn' }
    ])
    const out = await createRunner(deps({ openSession: () => session as unknown as AgentSession })).run(reviewer, ctx(), signal())
    expect(out).toMatchObject({ status: 'error', error: 'The answer has no JSON block', output: 'All good' })
  })

  it('stops a new-session step on abort', async () => {
    const session = fakeSession(null)
    const abort = new AbortController()
    const pending = createRunner(deps({ openSession: () => session as unknown as AgentSession })).run(reviewer, ctx(), abort.signal)
    await new Promise((r) => setTimeout(r, 5))
    abort.abort()
    expect(await pending).toMatchObject({ status: 'error', error: 'Interrupted' })
    expect(session.disposed).toBe(true)
  })

  it('gives shell commands earlier outputs through the environment', async () => {
    const out = await createRunner(deps()).run(
      { id: 'sh', type: 'action', action: 'shell', command: 'printf "%s|%s" "$PIPELINE_INPUT" "$PIPELINE_REVIEW_JSON"' },
      ctx({ review: { status: 'ok', output: 'x', json: { verdict: 'pass' } } }),
      signal()
    )
    expect(out).toEqual({ status: 'ok', output: 'add login|{"verdict":"pass"}', exitCode: 0 })
    const failed = await createRunner(deps()).run({ id: 'sh', type: 'action', action: 'shell', command: 'echo nope; exit 3' }, ctx(), signal())
    expect(failed).toMatchObject({ status: 'error', exitCode: 3, output: 'nope\n' })
  })
})

describe('extractJson', () => {
  it('takes the last JSON block of the latest message that has one', () => {
    expect(extractJson(['```json\n{"a":1}\n```', 'text\n```json\n{"a":2}\n```\nmore\n```json\n{"a":3}\n```'])).toEqual({ a: 3 })
    expect(extractJson(['```json\n{"a":1}\n```', 'no json here'])).toEqual({ a: 1 })
    expect(extractJson(['{"whole": true}'])).toEqual({ whole: true })
    expect(extractJson(['```json\n{broken\n```'])).toBeUndefined()
  })
})
