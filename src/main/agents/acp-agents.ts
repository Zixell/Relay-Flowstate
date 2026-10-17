import type { AgentDefinition } from './types'
import { createAcpChat } from './acp-chat'

/**
 * Agents integrated through the Agent Client Protocol: each runs as an ACP
 * server over stdio.
 */

export const geminiAgent: AgentDefinition = {
  id: 'gemini',
  label: 'Gemini CLI',
  description: "Google's coding agent",
  color: '#4285f4',
  enabled: true,

  binary: 'gemini',
  versionArgs: ['--version'],


  chat: createAcpChat({
    id: 'gemini',
    binary: 'gemini',
    args: ['--acp'],
    loginHint: 'Run `gemini` once in a terminal and sign in.'
  }),

  settings: []
}

export const openCodeAgent: AgentDefinition = {
  id: 'opencode',
  label: 'OpenCode',
  description: 'Open-source coding agent, any model provider',
  color: '#06b6d4',
  enabled: true,

  binary: 'opencode',
  versionArgs: ['--version'],


  chat: createAcpChat({
    id: 'opencode',
    binary: 'opencode',
    args: ['acp'],
    loginHint: 'Run `opencode auth login` in a terminal to connect a model provider.'
  }),

  settings: []
}

export const gooseAgent: AgentDefinition = {
  id: 'goose',
  label: 'Goose',
  description: "Block's open-source agent",
  color: '#f59e0b',
  enabled: true,

  binary: 'goose',
  versionArgs: ['--version'],


  chat: createAcpChat({
    id: 'goose',
    binary: 'goose',
    args: ['acp'],
    loginHint: 'Run `goose configure` in a terminal to set up a model provider.'
  }),

  settings: []
}
