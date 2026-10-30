#!/usr/bin/env node
// A tiny MCP server for tests: `repeat` echoes text, `fail` reports a tool error.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js')

const server = new Server({ name: 'mock', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'repeat',
      description: 'Repeats text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, times: { type: 'integer' }, loud: { type: 'boolean' } },
        required: ['text']
      }
    },
    { name: 'fail', inputSchema: { type: 'object', properties: {} } }
  ]
}))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {}
  if (req.params.name === 'fail') return { isError: true, content: [{ type: 'text', text: 'it broke' }] }
  const text = Array(args.times ?? 1).fill(args.text).join(' ')
  return {
    content: [{ type: 'text', text: args.loud ? text.toUpperCase() : text }],
    structuredContent: { args, env: process.env.MOCK_TOKEN ?? null }
  }
})
server.connect(new StdioServerTransport())
