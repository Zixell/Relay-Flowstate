/**
 * Agent abstraction.
 *
 * Everything Relay Flowstate needs to know about a CLI coding agent lives in a
 * single `AgentDefinition`. Adding support for a new agent means writing one
 * file in this folder and registering it in `registry.ts` — no changes to the
 * session manager, the summary generator, the IPC layer or the UI.
 */

/** Stable identifier persisted in `tasks.process_type`. Never change existing ids. */
import type { ChatSupport, AgentCapabilities } from './adapter'

export type AgentId = string

/** A command to run: executable + argv. */
export interface AgentCommand {
  cmd: string
  args: string[]
}

interface SettingDefBase {
  /** Settings key, persisted in the `settings` table. */
  key: string
  label: string
  description: string
}

export type AgentSettingDef =
  | (SettingDefBase & { type: 'boolean'; default: boolean })
  | (SettingDefBase & { type: 'select'; default: string; options: { id: string; label: string }[] })

/** Non-interactive invocation used for background work (session summaries). */
export interface HeadlessCommand extends AgentCommand {
  /** How the prompt is handed over. `stdin` avoids OS command-line length limits. */
  promptVia: 'stdin' | 'arg'
  /** Extracts the assistant's answer from raw stdout. Defaults to trimming. */
  parseOutput?: (stdout: string) => string
}

export interface AgentDefinition {
  id: AgentId
  label: string
  /** One-line description shown in the agent picker. */
  description: string
  /** Accent color (hex) used for badges and dots. */
  color: string
  /** When false the agent is listed in the UI but cannot be selected. */
  enabled: boolean

  /** Executable probed on PATH to decide whether the agent is installed. */
  binary: string
  /** Args that make `binary` print its version and exit 0. */
  versionArgs: string[]

  /** Used to generate session summaries without opening a terminal. */
  headless?: HeadlessCommand

  /** Agent-specific toggles surfaced in the Settings modal. */
  settings: AgentSettingDef[]

  /** How the app drives the agent: a structured session (SDK, JSON-RPC, ACP). */
  chat: ChatSupport

  /** Signing in to the agent's account from the app. */
  auth: AgentAuth
}

// --- Sign-in ------------------------------------------------------------------

/** Whether the agent's CLI is signed in. `signedIn: null` — the CLI cannot tell. */
export interface AuthStatus {
  signedIn: boolean | null
  /** Email or account name. */
  account?: string
  /** Plan or how it is signed in, e.g. "Max", "API key". */
  detail?: string
}

/**
 * A way to sign in. `browser` and `device` run in the app; `apiKey` asks for a
 * key; `terminal` runs `AgentAuth.terminal` in a terminal inside the app, for
 * CLIs whose sign-in is only interactive.
 */
export interface LoginMethod {
  id: string
  label: string
  description: string
  kind: 'browser' | 'device' | 'apiKey' | 'terminal'
}

/** Progress of a sign-in, pushed to the renderer. */
export type LoginUpdate =
  | { stage: 'starting' }
  /** Finish in the browser; `url` reopens it. `acceptsCode`: the page may show a code to paste back. */
  | { stage: 'browser'; url?: string; acceptsCode: boolean }
  /** Enter `code` at `url`. */
  | { stage: 'device'; url: string; code: string }
  | { stage: 'done' }
  | { stage: 'error'; message: string }

export interface LoginFlow {
  /** The code the browser showed, for flows that accept one. */
  submitCode?(code: string): void
  cancel(): void
}

export interface AgentAuth {
  methods: LoginMethod[]
  status(): Promise<AuthStatus>
  /** Starts an in-app sign-in (any method but `terminal`). */
  login?(methodId: string, input: { apiKey?: string }, onUpdate: (u: LoginUpdate) => void): LoginFlow
  logout?(): Promise<void>
  /** The interactive sign-in command, run in a terminal. */
  terminal?: AgentCommand
}

/** Serializable view of an agent, sent to the renderer over IPC. */
export interface AgentDescriptor {
  id: AgentId
  label: string
  description: string
  color: string
  enabled: boolean
  /** Whether the agent's binary was found on PATH. */
  available: boolean
  supportsSummaries: boolean
  chat: AgentCapabilities
  settings: AgentSettingDef[]
  loginMethods: LoginMethod[]
  canLogout: boolean
}
