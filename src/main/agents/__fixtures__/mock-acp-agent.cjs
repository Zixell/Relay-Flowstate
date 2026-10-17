#!/usr/bin/env node
// A scripted ACP agent for tests: replays the shape of a real Claude ACP trace.
const rl = require('readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } })
let nextId = 1000
const waiting = new Map()
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }) })
let cancelled = false
const root = process.cwd()

const modes = { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Manual' }, { id: 'auto', name: 'Auto' }] }
const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'Model One' }, { value: 'm2', name: 'Model Two' }] }]

rl.on('line', async (line) => {
  const m = JSON.parse(line)
  if (m.id != null && !m.method) { waiting.get(m.id)?.(m.result); waiting.delete(m.id); return }
  const p = m.params || {}
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {}, fork: {} } } } })
    case 'session/new':
      return send({ id: m.id, result: { sessionId: 'sess-1', modes, configOptions } })
    case 'session/load':
      update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Earlier question' } })
      update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer' } })
      update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'old-1', title: 'ls', kind: 'execute', status: 'completed', rawInput: { command: 'ls' }, content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }] })
      return send({ id: m.id, result: { modes, configOptions } })
    case 'session/list':
      return send({ id: m.id, result: { sessions: [{ sessionId: 'old-sess', cwd: root, title: 'Old chat', updatedAt: '2026-10-01T10:00:00Z' }] } })
    case 'session/fork':
      return send({ id: m.id, result: { sessionId: 'forked-' + p.sessionId } })
    case 'session/set_mode':
    case 'session/set_config_option':
      return send({ id: m.id, result: {} })
    case 'session/cancel':
      cancelled = true
      return
    case 'session/prompt': {
      const s = p.sessionId
      cancelled = false
      update(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking it over' } })
      update(s, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Preparing file…', kind: 'edit', status: 'pending', rawInput: {}, content: [], locations: [] })
      update(s, { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'Write hi.txt', rawInput: { file_path: root + '/hi.txt' }, locations: [{ path: root + '/hi.txt' }] })
      update(s, { sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [{ type: 'diff', path: root + '/hi.txt', oldText: null, newText: 'hi' }] })
      const answer = await ask('session/request_permission', { sessionId: s, toolCall: { toolCallId: 't1', title: 'Write hi.txt', kind: 'edit' }, options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'No', kind: 'reject_once' }] })
      const allowed = answer && answer.outcome && answer.outcome.optionId === 'yes'
      update(s, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed', rawOutput: allowed ? 'File created' : 'Denied' })
      update(s, { sessionUpdate: 'plan', entries: [{ content: 'Write the file', priority: 'high', status: 'completed' }] })
      update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Created ' } })
      update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi.txt.' } })
      update(s, { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 0.25, currency: 'USD' } })
      return send({ id: m.id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn', usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } } })
    }
    default:
      if (m.id != null) send({ id: m.id, error: { code: -32601, message: 'unknown ' + m.method } })
  }
})
