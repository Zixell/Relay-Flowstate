import { describe, expect, it } from 'vitest'
import { JsonRpcProcess } from './jsonrpc'

// A tiny agent: answers requests, and sends one request of its own.
const AGENT = `
const rl = require('readline').createInterface({ input: process.stdin })
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'ask', method: 'approve', params: {} }) + '\\n')
rl.on('line', (l) => {
  const m = JSON.parse(l)
  if (m.method === 'ping') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: 'pong' }) + '\\n')
})
`

describe('JsonRpcProcess', () => {
  it('round-trips requests and survives answering after kill', async () => {
    let answer: ((v: unknown) => void) | null = null
    const exited = new Promise<void>((resolve) => {
      const rpc = new JsonRpcProcess(process.execPath, ['-e', AGENT], {}, {
        onNotification: () => {},
        onRequest: () => new Promise((r) => (answer = r)),
        onExit: () => resolve()
      })
      void rpc.request('ping').then((r) => {
        expect(r).toBe('pong')
        rpc.kill()
        // The pending approval resolves after the process was told to stop.
        answer?.({ decision: 'cancel' })
      })
    })
    await exited
  })
})
