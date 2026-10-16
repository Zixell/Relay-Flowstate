import { describe, expect, it } from 'vitest'
import { initialStatusState, reduceStatus, type StatusState } from './status'
import type { AgentEvent } from '../agents/adapter'

const run = (events: AgentEvent[], from: StatusState = initialStatusState()): StatusState =>
  events.reduce(reduceStatus, from)

const perm = (requestId: string): AgentEvent => ({
  type: 'permission.requested',
  requestId,
  title: 'Write file',
  options: []
})

describe('reduceStatus', () => {
  it('runs a turn to completion', () => {
    const s = run([
      { type: 'turn.started', turnId: 't1' },
      { type: 'message.completed', messageId: 'm1', text: 'done' },
      { type: 'turn.completed', turnId: 't1', reason: 'end_turn' }
    ])
    expect(s.status).toBe('completed')
    expect(s.inTurn).toBe(false)
  })

  it('waits on permission and resumes running once answered', () => {
    let s = run([{ type: 'turn.started', turnId: 't1' }, perm('p1')])
    expect(s.status).toBe('waiting')
    s = reduceStatus(s, { type: 'permission.resolved', requestId: 'p1', optionId: 'allow' })
    expect(s.status).toBe('running')
  })

  it('stays waiting until every pending permission is answered', () => {
    let s = run([{ type: 'turn.started', turnId: 't1' }, perm('p1'), perm('p2')])
    s = reduceStatus(s, { type: 'permission.resolved', requestId: 'p1', optionId: 'allow' })
    expect(s.status).toBe('waiting')
  })

  it('maps interrupted turns to paused and errored turns to failed', () => {
    expect(run([{ type: 'turn.started', turnId: 't' }, { type: 'turn.completed', turnId: 't', reason: 'interrupted' }]).status).toBe('paused')
    expect(run([{ type: 'turn.started', turnId: 't' }, { type: 'turn.completed', turnId: 't', reason: 'error' }]).status).toBe('failed')
  })

  it('fails on a fatal error, ignores non-fatal ones', () => {
    const base = run([{ type: 'turn.started', turnId: 't' }])
    expect(reduceStatus(base, { type: 'error', message: 'retrying', fatal: false }).status).toBe('running')
    expect(reduceStatus(base, { type: 'error', message: 'boom', fatal: true }).status).toBe('failed')
  })

  it('treats an exit between turns as a normal shutdown', () => {
    const done = run([{ type: 'turn.started', turnId: 't' }, { type: 'turn.completed', turnId: 't', reason: 'end_turn' }])
    expect(reduceStatus(done, { type: 'session.exited', code: 1 }).status).toBe('completed')
  })

  it('fails when the agent dies mid-turn', () => {
    const s = run([{ type: 'turn.started', turnId: 't' }, { type: 'session.exited', code: 1 }])
    expect(s.status).toBe('failed')
  })
})
