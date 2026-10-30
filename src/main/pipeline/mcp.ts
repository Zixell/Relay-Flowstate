import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { StepOutput } from './types'

/**
 * Direct MCP tool calls for Tool blocks: no LLM in between. Servers come from
 * the Claude Code configuration the user already has — user scope and local
 * project scope in ~/.claude.json, and the project's .mcp.json.
 */

type ServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }

export interface McpServerInfo {
  name: string
  /** Where it is configured: `user`, `local` (this project in ~/.claude.json) or `project` (.mcp.json). */
  scope: 'user' | 'local' | 'project'
  transport: 'stdio' | 'http' | 'sse'
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema: { type?: string; properties?: Record<string, { type?: string | string[]; description?: string }>; required?: string[] }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Configured servers by name; later scopes win, as in Claude Code (project over local over user). */
function configured(projectPath?: string): Map<string, { scope: McpServerInfo['scope']; config: ServerConfig }> {
  const servers = new Map<string, { scope: McpServerInfo['scope']; config: ServerConfig }>()
  const add = (scope: McpServerInfo['scope'], list: unknown): void => {
    if (!list || typeof list !== 'object') return
    for (const [name, config] of Object.entries(list as Record<string, ServerConfig>)) servers.set(name, { scope, config })
  }
  const claude = readJson(join(homedir(), '.claude.json'))
  add('user', claude?.mcpServers)
  if (projectPath) {
    const projects = claude?.projects as Record<string, { mcpServers?: unknown }> | undefined
    add('local', projects?.[projectPath]?.mcpServers)
    add('project', readJson(join(projectPath, '.mcp.json'))?.mcpServers)
  }
  return servers
}

export function listMcpServers(projectPath?: string): McpServerInfo[] {
  return [...configured(projectPath)].map(([name, { scope, config }]) => ({
    name,
    scope,
    transport: 'url' in config ? config.type : 'stdio'
  }))
}

/** `${VAR}` and `${VAR:-default}`, as Claude Code expands them in MCP configs. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] ?? fallback ?? '')
}

function transportFor(config: ServerConfig, cwd: string): Transport {
  if ('url' in config) {
    const url = new URL(expandEnv(config.url))
    const headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([k, v]) => [k, expandEnv(v)]))
    return config.type === 'sse'
      ? new SSEClientTransport(url, { requestInit: { headers } })
      : new StreamableHTTPClientTransport(url, { requestInit: { headers } })
  }
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const [k, v] of Object.entries(config.env ?? {})) env[k] = expandEnv(v)
  return new StdioClientTransport({
    command: expandEnv(config.command),
    args: (config.args ?? []).map((a) => expandEnv(a)),
    env,
    cwd,
    stderr: 'ignore'
  })
}

async function withClient<T>(server: string, opts: { projectPath?: string; cwd: string }, fn: (c: Client) => Promise<T>): Promise<T> {
  const entry = configured(opts.projectPath).get(server)
  if (!entry) throw new Error(`MCP server "${server}" is not configured`)
  const client = new Client({ name: 'relay-pipeline', version: '1.0.0' })
  await client.connect(transportFor(entry.config, opts.cwd))
  try {
    return await fn(client)
  } finally {
    await client.close().catch(() => {})
  }
}

export async function listMcpTools(server: string, opts: { projectPath?: string; cwd: string }): Promise<McpToolInfo[]> {
  return withClient(server, opts, async (c) => (await c.listTools()).tools as McpToolInfo[])
}

/** Template-filled argument texts back into what the tool's schema asks for. */
export function coerceArgs(args: Record<string, unknown>, schema?: McpToolInfo['inputSchema']): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') {
      out[key] = value
      continue
    }
    // Empty optional fields are left out instead of sent as ""
    if (value === '' && !schema?.required?.includes(key)) continue
    const declared = schema?.properties?.[key]?.type
    const type = Array.isArray(declared) ? declared.find((t) => t !== 'null') : declared
    if (type === 'number' || type === 'integer') out[key] = Number(value)
    else if (type === 'boolean') out[key] = value.trim().toLowerCase() === 'true'
    else if (type === 'object' || type === 'array') {
      try {
        out[key] = JSON.parse(value)
      } catch {
        out[key] = value
      }
    } else out[key] = value
  }
  return out
}

export async function callMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { projectPath?: string; cwd: string; signal: AbortSignal }
): Promise<StepOutput> {
  return withClient(server, opts, async (c) => {
    const schema = ((await c.listTools()).tools as McpToolInfo[]).find((t) => t.name === tool)?.inputSchema
    if (!schema) return { status: 'error', output: '', error: `"${server}" has no tool "${tool}"` }
    const result = await c.callTool({ name: tool, arguments: coerceArgs(args, schema) }, undefined, { signal: opts.signal, timeout: 10 * 60_000 })
    const content = (result.content ?? []) as { type: string; text?: string }[]
    const output = content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n')
    let json: unknown = result.structuredContent
    if (json === undefined) {
      try {
        json = JSON.parse(output)
      } catch {
        // plain text
      }
    }
    return result.isError ? { status: 'error', output, json, error: firstLine(output) || 'The tool reported an error' } : { status: 'ok', output, json }
  })
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0]?.slice(0, 200) ?? ''
}
