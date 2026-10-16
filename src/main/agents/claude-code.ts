import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readdirSync } from 'fs'
import type { AgentDefinition } from './types'
import { UUID_RE_SOURCE } from './session-watcher'

const SKIP_PERMISSIONS = 'CLAUDE_SKIP_PERMISSIONS'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const SESSION_FILE_RE = new RegExp(`^(${UUID_RE_SOURCE})\\.jsonl$`, 'i')

function baseArgs(getBool: (key: string, fallback: boolean) => boolean): string[] {
  return getBool(SKIP_PERMISSIONS, true) ? ['--dangerously-skip-permissions'] : []
}

/**
 * Claude Code stores a directory per working directory, named after the path
 * with separators replaced by dashes (`/Users/me/app` → `-Users-me-app`).
 *
 * If this encoding ever changes, the lookup below simply finds nothing and
 * Relay falls back to starting a fresh session — never a wrong one.
 */
function projectDirFor(cwd: string): string {
  return join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

/** True when Claude has at least one recorded conversation for this directory. */
function hasSessionForCwd(cwd: string): boolean {
  const dir = projectDirFor(cwd)
  if (!existsSync(dir)) return false
  try {
    return readdirSync(dir).some((name) => SESSION_FILE_RE.test(name))
  } catch {
    return false
  }
}

/**
 * Anthropic's Claude Code.
 *
 * Sessions live at `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`; the file's
 * basename is the id accepted by `claude --resume <id>`.
 */
export const claudeCodeAgent: AgentDefinition = {
  id: 'claude-code',
  label: 'Claude Code',
  description: "Anthropic's coding agent",
  color: '#f97316',
  enabled: true,

  binary: 'claude',
  versionArgs: ['--version'],

  tracked: true,
  // Claude Code takes its prompt through the TUI, not argv — passing it on the
  // command line would start a non-interactive run.
  promptDelivery: 'input',
  // Claude Code renders "> " (or "❯ ") once it is ready for input.
  promptReadyPattern: /(?:^|\n)\s*[>❯]\s*$/,

  buildLaunchCommand: ({ getBool }) => ({ cmd: 'claude', args: baseArgs(getBool) }),

  buildResumeCommand: ({ resumeSessionId, getBool }) =>
    resumeSessionId
      ? { cmd: 'claude', args: ['--resume', resumeSessionId, ...baseArgs(getBool)] }
      : null,

  // `--continue` picks up the newest conversation recorded for the current
  // directory, which is what a task without a captured id needs. Safe here
  // because Claude scopes it per directory, not globally.
  buildContinueCommand: ({ getBool }) => ({
    cmd: 'claude',
    args: ['--continue', ...baseArgs(getBool)]
  }),

  hasSessionForCwd,

  sessionDiscovery: {
    rootDir: PROJECTS_DIR,
    filePattern: SESSION_FILE_RE
  },

  headless: {
    cmd: 'claude',
    args: ['--print', '--dangerously-skip-permissions'],
    promptVia: 'stdin'
  },

  settings: [
    {
      key: SKIP_PERMISSIONS,
      label: 'Skip permission prompts',
      description:
        'Passes --dangerously-skip-permissions when launching Claude. Disable if you prefer Claude to ask for confirmation before making file changes. Takes effect on the next session start or restart.',
      type: 'boolean',
      default: true
    }
  ]
}
