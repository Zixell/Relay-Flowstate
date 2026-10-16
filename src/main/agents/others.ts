import type { AgentDefinition } from './types'

const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash'

/**
 * Agents that Relay Flowstate can launch but has no first-class integration for
 * yet (no session resume, no session-id capture). They are listed in the picker
 * but disabled until their integration is filled in.
 */

export const aiderAgent: AgentDefinition = {
  id: 'aider',
  label: 'Aider',
  description: 'Pair-programming CLI (coming soon)',
  color: '#8b5cf6',
  enabled: false,

  binary: 'aider',
  versionArgs: ['--version'],

  tracked: true,
  promptDelivery: 'input',

  buildLaunchCommand: () => ({ cmd: 'aider', args: ['--yes'] }),

  settings: []
}

export const openCodeAgent: AgentDefinition = {
  id: 'opencode',
  label: 'OpenCode',
  description: 'Open-source coding agent (coming soon)',
  color: '#06b6d4',
  enabled: false,

  binary: 'opencode',
  versionArgs: ['--version'],

  tracked: true,
  promptDelivery: 'input',

  buildLaunchCommand: () => ({ cmd: 'opencode', args: [] }),

  settings: []
}

/**
 * Plain interactive shell. `tracked: false` disables status detection and
 * summary generation — there is no agent whose activity we could interpret.
 */
export const genericAgent: AgentDefinition = {
  id: 'generic',
  label: 'CLI Tool',
  description: 'Plain interactive shell (coming soon)',
  color: '#6b7280',
  enabled: false,

  binary: shell,
  versionArgs: process.platform === 'win32' ? ['/c', 'ver'] : ['--version'],

  tracked: false,
  promptDelivery: 'none',

  buildLaunchCommand: () => ({ cmd: shell, args: [] }),

  settings: []
}
