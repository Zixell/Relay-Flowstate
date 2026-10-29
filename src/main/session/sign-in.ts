import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { getAgent, isAgentAvailable } from '../agents'
import type { AuthStatus, LoginFlow, LoginUpdate } from '../agents/types'
import { resolveExecutable } from '../agents/resolve-executable'
import { openConsole } from '../console/manager'
import { broadcast } from '../windows'
import { restartIdleSessions } from './manager'

/**
 * Signing in to agent accounts from the app. A flow's progress goes to every
 * window on `auth:update`; when it succeeds, the agent's idle chats restart so
 * they use the new credentials.
 */

export interface AuthUpdatePayload {
  flowId: string
  agentId: string
  update: LoginUpdate
}

const flows = new Map<string, LoginFlow>()

export async function authStatus(agentId: string): Promise<AuthStatus> {
  if (!isAgentAvailable(agentId)) return { signedIn: null }
  try {
    return await getAgent(agentId).auth.status()
  } catch (err) {
    console.warn(`[relay] reading ${agentId} sign-in status failed:`, err)
    return { signedIn: null }
  }
}

function signedIn(agentId: string): void {
  void restartIdleSessions(agentId).catch((err) => console.warn('[relay] restarting sessions after sign-in failed:', err))
}

/** Starts an in-app sign-in. Returns the flow id that `auth:update` events carry. */
export function startLogin(agentId: string, methodId: string, input: { apiKey?: string }): string {
  const login = getAgent(agentId).auth.login
  if (!login) throw new Error('This agent signs in in the terminal')
  const flowId = randomUUID()
  const emit = (update: LoginUpdate): void => {
    if (update.stage === 'done' || update.stage === 'error') flows.delete(flowId)
    if (update.stage === 'done') signedIn(agentId)
    broadcast('auth:update', { flowId, agentId, update } satisfies AuthUpdatePayload)
  }
  try {
    flows.set(flowId, login(methodId, input, emit))
  } catch (err) {
    // Reported through the event, after the caller has the id.
    setImmediate(() => emit({ stage: 'error', message: err instanceof Error ? err.message : String(err) }))
  }
  return flowId
}

export function submitLoginCode(flowId: string, code: string): void {
  flows.get(flowId)?.submitCode?.(code)
}

export function cancelLogin(flowId: string): void {
  flows.get(flowId)?.cancel()
  flows.delete(flowId)
}

export function cancelAllLogins(): void {
  for (const id of [...flows.keys()]) cancelLogin(id)
}

export async function logout(agentId: string): Promise<void> {
  const out = getAgent(agentId).auth.logout
  if (!out) throw new Error('This agent cannot sign out from the app')
  await out()
}

/** Console id of an agent's sign-in terminal; it uses the console channels. */
export function loginTerminalId(agentId: string): string {
  return `login:${agentId}`
}

/** Runs the agent's interactive sign-in command in a terminal. */
export function openLoginTerminal(agentId: string, cols: number, rows: number): { available: boolean; scrollback: string } {
  const terminal = getAgent(agentId).auth.terminal
  if (!terminal) throw new Error('This agent signs in inside the app')
  const executable = resolveExecutable(terminal.cmd)
  if (!executable) throw new Error(`${terminal.cmd} not found. Install it and make sure it is on your PATH.`)
  // Once it closes the CLI may have stored new credentials.
  return openConsole(loginTerminalId(agentId), homedir(), cols, rows, {
    file: executable,
    args: terminal.args,
    onExit: () => signedIn(agentId)
  })
}
