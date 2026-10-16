import { describe, expect, it } from 'vitest'
import { applyChatEvent, emptyChat, upsertMessage } from './chatReducer'
import type { ChatMessage } from '../types'

const msg = (id: string, seq: number, content = 'x'): ChatMessage => ({
  id, seq, content, task_id: 't', turn_id: null, role: 'assistant', kind: 'text',
  tool_call_id: null, tool_status: null, created_at: 0, updated_at: 0
})

describe('chat reducer', () => {
  it('accumulates deltas and drops them once the message is persisted', () => {
    let s = applyChatEvent(emptyChat(), { event: { type: 'turn.started', turnId: 't1' } })
    s = applyChatEvent(s, { event: { type: 'message.delta', messageId: 'm', text: 'Hel' } })
    s = applyChatEvent(s, { event: { type: 'message.delta', messageId: 'm', text: 'lo' } })
    expect(s.streaming.m).toBe('Hello')
    expect(s.streamingOrder).toEqual(['m'])
    s = applyChatEvent(s, { event: { type: 'message.completed', messageId: 'm', text: 'Hello' }, message: msg('row', 1, 'Hello') })
    expect(s.streaming).toEqual({})
    expect(s.messages.map((m) => m.content)).toEqual(['Hello'])
  })

  it('updates rows in place and keeps seq order', () => {
    let list = upsertMessage([], msg('a', 2))
    list = upsertMessage(list, msg('b', 1))
    list = upsertMessage(list, { ...msg('a', 2), content: 'changed' })
    expect(list.map((m) => `${m.id}:${m.content}`)).toEqual(['b:x', 'a:changed'])
  })

  it('records cost and clears turn state on completion', () => {
    let s = applyChatEvent(emptyChat(), { event: { type: 'turn.started', turnId: 't' } })
    s = applyChatEvent(s, { event: { type: 'message.delta', messageId: 'm', text: 'half' } })
    s = applyChatEvent(s, { event: { type: 'turn.completed', turnId: 't', reason: 'interrupted', usage: { costUsd: 0.5 } } })
    expect(s).toMatchObject({ inTurn: false, streaming: {}, costUsd: 0.5 })
  })
})
