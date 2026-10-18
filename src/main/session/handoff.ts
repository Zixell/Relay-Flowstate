import { getMessages, getTaskById, getTaskSummaries, type MessageRow } from '../db'
import { getGitChanges } from '../git'

/** Recorded on the task (metadata.handoff) when it moves to another agent. */
export interface HandoffInfo {
  from: string
  fromLabel: string
  to: string
  toLabel: string
  /** Unix seconds; turns started before this belong to the previous agent. */
  at: number
  /** True until the context has been sent to the new agent with the first message. */
  pending: boolean
}

interface TaskRow {
  title: string
  prompt: string
  project_path: string
  worktree_path: string | null
  branch: string | null
  plan_json: string | null
  metadata: string | null
}

const MAX_CONTEXT = 40_000
const MAX_ENTRY = 2_000

function clip(text: string, max = MAX_ENTRY): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}… [truncated]` : t
}

function toolLine(m: MessageRow): string {
  try {
    const c = JSON.parse(m.content ?? '{}') as { kind?: string; name?: string; title?: string; input?: { command?: string } }
    const what = c.kind === 'bash' && c.input?.command ? `ran \`${clip(c.input.command, 200)}\`` : `${c.kind ?? c.name ?? 'tool'}: ${clip(c.title ?? '', 200)}`
    const status = m.tool_status === 'error' ? ' (failed)' : m.tool_status === 'running' ? ' (interrupted)' : ''
    return `  - ${what}${status}`
  } catch {
    return ''
  }
}

/** The conversation as plain lines: what the user asked, what the agent said and did. */
function transcriptLines(messages: MessageRow[]): string[] {
  const lines: string[] = []
  for (const m of messages) {
    if (m.kind === 'text' && m.content?.trim()) {
      lines.push(m.role === 'user' ? `\nUser: ${clip(m.content)}` : `Agent: ${clip(m.content)}`)
    } else if (m.kind === 'tool_call') {
      const line = toolLine(m)
      if (line) lines.push(line)
    } else if (m.kind === 'error' && m.content) {
      lines.push(`  [error] ${clip(m.content, 300)}`)
    } else if (m.kind === 'handoff' && m.content) {
      try {
        const h = JSON.parse(m.content) as { fromLabel: string; toLabel: string }
        lines.push(`\n[The task moved from ${h.fromLabel} to ${h.toLabel} here.]`)
      } catch {
        // ignore
      }
    }
  }
  return lines
}

/**
 * Everything a different agent needs to pick a task up: the goal, what has
 * been said and done so far, the plan, and the files already changed in the
 * worktree. Sent once, ahead of the user's first message to the new agent.
 */
export function buildHandoffContext(taskId: string, handoff: HandoffInfo): string {
  const task = getTaskById(taskId) as TaskRow | null
  if (!task) return ''
  const cwd = task.worktree_path || task.project_path
  const meta = (() => {
    try {
      return task.metadata ? (JSON.parse(task.metadata) as { startCommit?: string }) : {}
    } catch {
      return {}
    }
  })()

  const sections: string[] = []
  sections.push(
    `You are taking over a coding task that ${handoff.fromLabel} was working on (it stopped, for example because it ran out of usage). ` +
      `You are in the same working directory (${cwd}), which already contains all of its changes. ` +
      `Pick up from where it left off: check the current state (e.g. git status / git diff) when useful, do not redo work that is already done, ` +
      `and then act on the user's message below.`
  )
  sections.push(`## Task\n${task.title}\n\nOriginal request:\n${clip(task.prompt, 4000)}`)

  try {
    const plan = task.plan_json ? (JSON.parse(task.plan_json) as { text: string; status: string }[]) : []
    if (plan.length) {
      sections.push(`## Plan so far\n${plan.map((p) => `- [${p.status === 'done' ? 'x' : p.status === 'in_progress' ? '~' : ' '}] ${p.text}`).join('\n')}`)
    }
  } catch {
    // no plan
  }

  const summaries = getTaskSummaries(taskId)
  if (summaries.length) {
    try {
      const last = JSON.parse(summaries[summaries.length - 1].summary_json) as { text?: string }
      if (last.text) sections.push(`## Summary of the work so far\n${clip(last.text, 3000)}`)
    } catch {
      // ignore
    }
  }

  try {
    const files = getGitChanges(cwd, undefined, meta.startCommit).files
    if (files.length) {
      sections.push(
        `## Files changed in this task\n${files
          .slice(0, 100)
          .map((f) => `- ${f.path} (${f.type}, +${f.additions} −${f.deletions})`)
          .join('\n')}`
      )
    }
  } catch {
    // not a git repo
  }

  // Keep the newest part of the conversation when it is long.
  const lines = transcriptLines(getMessages(taskId, { limit: 100_000 }))
  const budget = MAX_CONTEXT - sections.join('\n\n').length
  let used = 0
  let start = lines.length
  while (start > 0 && used + lines[start - 1].length + 1 <= budget) {
    used += lines[start - 1].length + 1
    start--
  }
  const transcript = (start > 0 ? ['[… earlier conversation omitted …]'] : []).concat(lines.slice(start)).join('\n').trim()
  if (transcript) sections.push(`## Conversation so far (with ${handoff.fromLabel})\n${transcript}`)

  return `<handoff>\n${sections.join('\n\n')}\n</handoff>`
}

export function readHandoff(metadata: string | null | undefined): HandoffInfo | null {
  try {
    const meta = metadata ? (JSON.parse(metadata) as { handoff?: HandoffInfo }) : {}
    return meta.handoff ?? null
  } catch {
    return null
  }
}
