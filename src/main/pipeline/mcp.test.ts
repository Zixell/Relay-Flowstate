import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { callMcpTool, coerceArgs, expandEnv, listMcpServers, listMcpTools } from './mcp'

/** A project whose .mcp.json points at the mock server. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-mcp-'))
  const server = join(__dirname, '__fixtures__', 'mock-mcp-server.cjs')
  writeFileSync(
    join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { mock: { command: process.execPath, args: [server], env: { MOCK_TOKEN: '${RELAY_TEST_TOKEN:-fallback}' } } } })
  )
  return dir
}

describe('mcp', () => {
  it('expands ${VAR} and ${VAR:-default}', () => {
    expect(expandEnv('a ${X} ${Y:-b} ${Z}', { X: '1' })).toBe('a 1 b ')
  })

  it('turns filled-in argument texts into the types the tool asks for', () => {
    const schema = {
      properties: { n: { type: 'integer' }, on: { type: 'boolean' }, list: { type: 'array' }, s: { type: 'string' }, opt: { type: 'string' } },
      required: ['s']
    }
    expect(coerceArgs({ n: '3', on: 'True', list: '["a"]', s: '', opt: '' }, schema)).toEqual({ n: 3, on: true, list: ['a'], s: '' })
  })

  it("finds the project's servers and calls a tool over stdio", async () => {
    const dir = project()
    expect(listMcpServers(dir)).toContainEqual({ name: 'mock', scope: 'project', transport: 'stdio' })
    const tools = await listMcpTools('mock', { projectPath: dir, cwd: dir })
    expect(tools.map((t) => t.name)).toEqual(['repeat', 'fail'])

    const out = await callMcpTool('mock', 'repeat', { text: 'hi', times: '2', loud: 'true' }, { projectPath: dir, cwd: dir, signal: new AbortController().signal })
    expect(out).toEqual({ status: 'ok', output: 'HI HI', json: { args: { text: 'hi', times: 2, loud: true }, env: 'fallback' } })

    const failed = await callMcpTool('mock', 'fail', {}, { projectPath: dir, cwd: dir, signal: new AbortController().signal })
    expect(failed).toMatchObject({ status: 'error', output: 'it broke', error: 'it broke' })

    const missing = await callMcpTool('mock', 'nope', {}, { projectPath: dir, cwd: dir, signal: new AbortController().signal })
    expect(missing).toMatchObject({ status: 'error', error: '"mock" has no tool "nope"' })
  }, 20_000)
})
