import type { AgentCommand, AgentDefinition } from './types'
import { getBoolSetting } from './registry'

export interface BuildLaunchOptions {
  cwd: string
  /** Initial prompt for a fresh session. Ignored when resuming. */
  prompt?: string
  /** Captured session id — when present the agent is asked to resume it. */
  resumeSessionId?: string
  /**
   * Allows falling back to "continue the newest conversation in this directory"
   * when no session id was captured. Set this only when restarting an existing
   * task: a brand-new task must start its own conversation, never adopt one.
   */
  allowContinue?: boolean
}

export type ResumeMode =
  /** Fresh session — nothing to continue. */
  | 'none'
  /** Resumed the exact conversation Relay recorded for this task. */
  | 'session-id'
  /** No id was recorded; continued the newest conversation in the task's directory. */
  | 'continue'

export interface ResolvedLaunch {
  command: AgentCommand
  /** Prompt that must be typed into the TUI after startup, if any. */
  typedPrompt?: string
  /** True when this launch continues a previous session. */
  resumed: boolean
  /** How the previous session was picked up. */
  resumeMode: ResumeMode
  /** Whether status tracking and summaries apply to this session. */
  tracked: boolean
}

/**
 * Longest prompt still safe to put on a command line. The agent command is
 * written into an interactive shell, and cmd.exe truncates past ~8191 chars —
 * anything longer is typed into the TUI instead.
 */
const MAX_PROMPT_AS_ARG = process.platform === 'win32' ? 6000 : 100_000

/**
 * Turns an agent definition plus launch options into a concrete command.
 *
 * Handles the prompt-delivery strategies uniformly so callers (IPC handlers,
 * PTY manager) never branch on which agent they are dealing with.
 */
export function resolveLaunch(
  agent: AgentDefinition,
  opts: BuildLaunchOptions
): ResolvedLaunch {
  const ctx = {
    cwd: opts.cwd,
    resumeSessionId: opts.resumeSessionId,
    getBool: getBoolSetting
  }

  // 1. Exact resume — the id Relay captured when the session first started.
  let resumeCommand = opts.resumeSessionId
    ? agent.buildResumeCommand?.({ ...ctx, prompt: opts.prompt }) ?? null
    : null
  let resumeMode: ResumeMode = resumeCommand ? 'session-id' : 'none'

  // 2. No id (task predates id tracking, or the watcher missed the session
  //    file) — let the agent continue the newest conversation in this directory.
  if (
    !resumeCommand &&
    opts.allowContinue &&
    agent.buildContinueCommand &&
    agent.hasSessionForCwd?.(opts.cwd)
  ) {
    resumeCommand = agent.buildContinueCommand({ ...ctx, prompt: opts.prompt })
    if (resumeCommand) resumeMode = 'continue'
  }

  const resumed = resumeCommand !== null

  // Resumed sessions carry their history, so the original prompt is not replayed.
  const prompt = resumed ? undefined : opts.prompt

  // An oversized prompt falls back to keyboard delivery so it is never truncated.
  const asArg =
    agent.promptDelivery === 'arg' && prompt !== undefined && prompt.length <= MAX_PROMPT_AS_ARG

  const command =
    resumeCommand ?? agent.buildLaunchCommand({ ...ctx, prompt: asArg ? prompt : undefined })

  const typedPrompt =
    prompt && agent.promptDelivery !== 'none' && !asArg ? prompt : undefined

  return { command, typedPrompt, resumed, resumeMode, tracked: agent.tracked }
}

/**
 * Command-line arguments are written into an interactive shell, so a prompt
 * carrying newlines has to be flattened on cmd.exe, which cannot represent them.
 * bash handles them fine inside single quotes.
 */
export function sanitizeArgForShell(arg: string): string {
  if (process.platform !== 'win32') return arg
  return arg.replace(/\r?\n/g, ' ')
}
