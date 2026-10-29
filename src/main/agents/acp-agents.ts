import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { AgentAuth, AgentCommand, AgentDefinition, AuthStatus } from './types'
import { createAcpChat } from './acp-chat'

/** These CLIs sign in only interactively: the app runs the command in a terminal. */
function terminalAuth(terminal: AgentCommand, description: string, status?: () => AuthStatus): AgentAuth {
  return {
    methods: [{ id: 'terminal', label: 'Sign in in the terminal', description, kind: 'terminal' }],
    status: async () => status?.() ?? { signedIn: null },
    terminal
  }
}

/** Gemini keeps its Google sign-in in ~/.gemini; an API key may come from the environment instead. */
function geminiStatus(): AuthStatus {
  if (existsSync(join(homedir(), '.gemini', 'oauth_creds.json'))) return { signedIn: true, detail: 'Google account' }
  if (process.env.GEMINI_API_KEY) return { signedIn: true, detail: 'Gemini API key' }
  return { signedIn: null }
}

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

  auth: terminalAuth(
    { cmd: 'gemini', args: [] },
    'Gemini asks how to sign in: Google account, Gemini API key or Vertex AI. Type /quit when done.',
    geminiStatus
  ),

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

  auth: terminalAuth({ cmd: 'opencode', args: ['auth', 'login'] }, 'Pick a model provider and sign in to it or paste its API key.'),

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

  auth: terminalAuth({ cmd: 'goose', args: ['configure'] }, 'Choose a model provider and enter its credentials.'),

  settings: []
}
