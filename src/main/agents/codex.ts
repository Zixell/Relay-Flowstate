import { homedir } from 'os'
import { join } from 'path'
import type { AgentDefinition } from './types'
import { UUID_RE_SOURCE } from './session-watcher'
import { codexChat, CODEX_BYPASS_APPROVALS } from './codex-chat'

const BYPASS_APPROVALS = CODEX_BYPASS_APPROVALS

function baseArgs(getBool: (key: string, fallback: boolean) => boolean): string[] {
  // --dangerously-bypass-approvals-and-sandbox is Codex's equivalent of Claude's
  // --dangerously-skip-permissions; --full-auto still sandboxes writes to the
  // workspace and asks for approval when a command fails.
  return getBool(BYPASS_APPROVALS, true)
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['--full-auto']
}

/**
 * Extracts the final assistant message from `codex exec --json` output.
 *
 * The event schema has changed across Codex releases, so this scans every JSONL
 * line for anything that looks like an agent message and keeps the last one.
 * Falls back to the raw text when no JSON is recognised.
 */
function parseCodexExecOutput(stdout: string): string {
  const messages: string[] = []

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    collectAgentMessages(event, messages)
  }

  if (messages.length > 0) return messages[messages.length - 1].trim()

  // Not JSONL (older Codex, or --json unsupported) — drop the leading metadata
  // block that `codex exec` prints before the run and keep the rest.
  const withoutHeader = stdout.replace(/^[\s\S]*?\n--------\n/, '')
  return withoutHeader.trim() || stdout.trim()
}

/** Walks an arbitrary event object looking for `agent_message`-shaped payloads. */
function collectAgentMessages(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>

  const type = typeof obj.type === 'string' ? obj.type : ''
  if (type.includes('agent_message') || type === 'assistant_message') {
    const text = obj.text ?? obj.message ?? obj.content
    if (typeof text === 'string' && text.trim()) out.push(text)
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') collectAgentMessages(value, out)
  }
}

/**
 * OpenAI Codex CLI.
 *
 * Rollouts live at `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl`;
 * the trailing UUID is the id accepted by `codex resume <id>`.
 */
export const codexAgent: AgentDefinition = {
  id: 'codex',
  label: 'Codex',
  description: "OpenAI's coding agent",
  color: '#10b981',
  enabled: true,

  binary: 'codex',
  versionArgs: ['--version'],

  tracked: true,
  chat: codexChat,
  // `codex "<prompt>"` opens the TUI and immediately starts on the prompt, which
  // is far more reliable than typing into the composer after startup.
  promptDelivery: 'arg',

  buildLaunchCommand: ({ prompt, getBool }) => ({
    cmd: 'codex',
    args: [...baseArgs(getBool), ...(prompt ? [prompt] : [])]
  }),

  buildResumeCommand: ({ resumeSessionId, getBool }) =>
    resumeSessionId
      ? { cmd: 'codex', args: ['resume', resumeSessionId, ...baseArgs(getBool)] }
      : null,

  sessionDiscovery: {
    rootDir: join(homedir(), '.codex', 'sessions'),
    // Matches both `rollout-<timestamp>-<uuid>.jsonl` and a bare `<uuid>.jsonl`.
    filePattern: new RegExp(`^(?:rollout-.*?-)?(${UUID_RE_SOURCE})\\.jsonl$`, 'i')
  },

  headless: {
    cmd: 'codex',
    // A bare `-` tells `codex exec` to read the prompt from stdin.
    args: ['exec', '--json', '--skip-git-repo-check', '-'],
    promptVia: 'stdin',
    parseOutput: parseCodexExecOutput
  },

  settings: [
    {
      key: BYPASS_APPROVALS,
      label: 'Bypass approvals and sandbox',
      description:
        'Passes --dangerously-bypass-approvals-and-sandbox when launching Codex. Disable to run with --full-auto instead, which sandboxes writes to the workspace. In chat mode this picks the default permission mode (Full access vs Auto). Takes effect on the next session start or restart.',
      type: 'boolean',
      default: true
    }
  ]
}
