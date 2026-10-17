import type { AgentDefinition } from './types'
import { codexChat, CODEX_BYPASS_APPROVALS } from './codex-chat'

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

/** OpenAI Codex, driven through `codex app-server` with the user's own CLI and login. */
export const codexAgent: AgentDefinition = {
  id: 'codex',
  label: 'Codex',
  description: "OpenAI's coding agent",
  color: '#10b981',
  enabled: true,

  binary: 'codex',
  versionArgs: ['--version'],

  chat: codexChat,

  headless: {
    cmd: 'codex',
    // A bare `-` tells `codex exec` to read the prompt from stdin.
    args: ['exec', '--json', '--skip-git-repo-check', '-'],
    promptVia: 'stdin',
    parseOutput: parseCodexExecOutput
  },

  settings: [
    {
      key: CODEX_BYPASS_APPROVALS,
      label: 'Full access by default',
      description:
        'New Codex sessions start in "Full access" mode (no approvals, no sandbox). Turn off to start in "Auto (sandboxed)"; the mode can be changed per task under the composer.',
      type: 'boolean',
      default: true
    }
  ]
}
