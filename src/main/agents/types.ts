/**
 * Agent abstraction.
 *
 * Everything Relay Flowstate needs to know about a CLI coding agent lives in a
 * single `AgentDefinition`. Adding support for a new agent means writing one
 * file in this folder and registering it in `registry.ts` — no changes to the
 * PTY manager, the summary generator, the IPC layer or the UI.
 */

/** Stable identifier persisted in `tasks.process_type`. Never change existing ids. */
import type { ChatSupport, AgentCapabilities } from './adapter'

export type AgentId = string

/** A command to run: executable + argv. */
export interface AgentCommand {
  cmd: string
  args: string[]
}

/** How the initial prompt reaches the agent. */
export type PromptDelivery =
  /** Passed on the command line — the agent starts already working on it. */
  | 'arg'
  /** Typed into the agent's interactive TUI once it signals readiness. */
  | 'input'
  /** The agent takes no prompt (plain shell). */
  | 'none'

export interface AgentSettingDef {
  /** Settings key, persisted in the `settings` table. */
  key: string
  label: string
  description: string
  type: 'boolean'
  default: boolean
}

/** Where an agent records its conversations, so we can capture the session id. */
export interface SessionDiscovery {
  /** Absolute path to the directory tree that is scanned (may not exist yet). */
  rootDir: string
  /**
   * Matched against each file's basename. The first capture group is used as
   * the session id passed back to `buildResumeCommand`.
   */
  filePattern: RegExp
}

/** Non-interactive invocation used for background work (session summaries). */
export interface HeadlessCommand extends AgentCommand {
  /** How the prompt is handed over. `stdin` avoids OS command-line length limits. */
  promptVia: 'stdin' | 'arg'
  /** Extracts the assistant's answer from raw stdout. Defaults to trimming. */
  parseOutput?: (stdout: string) => string
}

export interface LaunchContext {
  cwd: string
  /** Initial prompt, when the task is being started for the first time. */
  prompt?: string
  /** Previously captured session id, when resuming. */
  resumeSessionId?: string
  /** Reads a persisted app setting (see `AgentDefinition.settings`). */
  getBool: (key: string, fallback: boolean) => boolean
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

  /**
   * When true the session is treated as an agent run: status tracking,
   * inactivity detection and summary generation are enabled.
   * Plain shells set this to false.
   */
  tracked: boolean

  promptDelivery: PromptDelivery

  /**
   * Only used with `promptDelivery: 'input'`. Matched against the tail of the
   * ANSI-stripped output stream to detect "the TUI is ready for typing".
   * When absent, delivery falls back to silence detection.
   */
  promptReadyPattern?: RegExp

  /** Builds the command for a fresh session. */
  buildLaunchCommand: (ctx: LaunchContext) => AgentCommand

  /**
   * Builds the command that continues a previous session. Return null when the
   * session cannot be resumed — the caller then starts a fresh session.
   */
  buildResumeCommand?: (ctx: LaunchContext) => AgentCommand | null

  /**
   * Fallback for tasks whose session id was never captured (the agent was
   * launched before Relay tracked ids, or the watcher missed the file):
   * continues the most recent conversation in `ctx.cwd`.
   *
   * Only implement this when the agent scopes "most recent conversation" to the
   * working directory. An agent that continues the last session *globally* must
   * leave this undefined — it would resume another task's conversation.
   */
  buildContinueCommand?: (ctx: LaunchContext) => AgentCommand | null

  /**
   * Guards `buildContinueCommand`: true when `cwd` has a previous conversation
   * to continue. Returning false keeps Relay from issuing a continue command
   * that the agent would reject.
   */
  hasSessionForCwd?: (cwd: string) => boolean

  /** Where new session files appear, so the session id can be captured. */
  sessionDiscovery?: SessionDiscovery

  /** Used to generate session summaries without opening a terminal. */
  headless?: HeadlessCommand

  /** Agent-specific toggles surfaced in the Settings modal. */
  settings: AgentSettingDef[]

  /**
   * Structured (chat-mode) driver. Agents without it can only run in the
   * legacy terminal mode.
   */
  chat?: ChatSupport
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
  supportsResume: boolean
  supportsSummaries: boolean
  /** Present when the agent can run in chat mode. */
  chat?: AgentCapabilities
  settings: AgentSettingDef[]
}
