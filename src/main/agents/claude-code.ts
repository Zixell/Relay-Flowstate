import type { AgentDefinition } from './types'
import { claudeChat, SKIP_PERMISSIONS } from './claude-chat'

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

  headless: {
    cmd: 'claude',
    args: ['--print', '--dangerously-skip-permissions'],
    promptVia: 'stdin'
  },

  chat: claudeChat,

  settings: [
    {
      key: SKIP_PERMISSIONS,
      label: 'Skip permission prompts by default',
      description:
        'New Claude sessions start in "Bypass permissions" mode. Turn off to start in "Ask before acting"; the mode can be changed per task under the composer.',
      type: 'boolean',
      default: true
    }
  ]
}
