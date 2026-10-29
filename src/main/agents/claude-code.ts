import type { AgentDefinition } from './types'
import { claudeChat, DEFAULT_MODE, MODE_OPTIONS } from './claude-chat'
import { claudeAuth } from './claude-auth'

/**
 * Anthropic's Claude Code, driven through the Claude Agent SDK with the
 * user's own `claude` CLI and login.
 */
export const claudeCodeAgent: AgentDefinition = {
  id: 'claude-code',
  label: 'Claude Code',
  description: "Anthropic's coding agent",
  color: '#f97316',
  enabled: true,

  binary: 'claude',
  versionArgs: ['--version'],

  // Recaps only need plain text: a small model with no tools, MCP servers,
  // settings or CLAUDE.md costs ~1k tokens instead of a full agent run (~25k).
  // Args are joined into a shell command, hence the quoted empty and spaced values.
  headless: {
    cmd: 'claude',
    args: [
      '--print',
      '--model', 'haiku',
      '--tools', '""',
      '--strict-mcp-config',
      '--setting-sources', '""',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--system-prompt', '"You write short plain-prose summaries of coding sessions for a developer log."'
    ],
    promptVia: 'stdin'
  },

  chat: claudeChat,

  auth: claudeAuth,

  settings: [
    {
      key: DEFAULT_MODE,
      label: 'Default permission mode',
      description:
        'Mode new Claude sessions start in. "Auto" lets a classifier approve safe actions and asks only about risky ones, as in the CLI. The mode can be changed per task under the composer.',
      type: 'select',
      default: 'auto',
      options: MODE_OPTIONS
    }
  ]
}
