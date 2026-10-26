import { describe, expect, it } from 'vitest'
import type { AgentEvent, BackgroundTask } from './adapter'
import { claudeChat, taskKind } from './claude-chat'

/** Feeds SDK messages through a session's live mapping and returns the background lists it reported. */
function backgroundLists(messages: unknown[]): BackgroundTask[][] {
  const session = claudeChat.createSession({ taskId: 't', cwd: '/repo', getSetting: () => '' }) as unknown as {
    onEvent: (cb: (e: AgentEvent) => void) => void
    replay: (msg: unknown) => void
  }
  const lists: BackgroundTask[][] = []
  session.onEvent((e) => {
    if (e.type === 'background.updated') lists.push(e.tasks)
  })
  for (const m of messages) session.replay(m)
  return lists
}

const sys = (subtype: string, rest: Record<string, unknown>): unknown => ({ type: 'system', subtype, uuid: 'u', session_id: 's', ...rest })

describe('Claude background tasks', () => {
  it('lists running tasks with their command, then moves them to ended', () => {
    const lists = backgroundLists([
      {
        type: 'assistant',
        uuid: 'a1',
        session_id: 's',
        parent_tool_use_id: null,
        message: { id: 'm1', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm run build' } }] }
      },
      sys('task_started', { task_id: 'b1', tool_use_id: 'tool-1', description: 'Build', task_type: 'local_bash' }),
      sys('background_tasks_changed', { tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'Build' }] }),
      sys('task_notification', { task_id: 'b1', status: 'completed', output_file: '/tmp/o', summary: 'Built in 12s' }),
      sys('background_tasks_changed', { tasks: [] })
    ])
    expect(lists[0]).toEqual([
      { id: 'b1', type: 'shell', description: 'Build', command: 'npm run build', toolCallId: 'tool-1', status: 'running' }
    ])
    expect(lists.at(-1)).toEqual([
      { id: 'b1', type: 'shell', description: 'Build', command: 'npm run build', toolCallId: 'tool-1', status: 'completed', summary: 'Built in 12s' }
    ])
  })

  it('leaves out ambient tasks and foreground tasks that end', () => {
    const lists = backgroundLists([
      sys('background_tasks_changed', { tasks: [{ task_id: 'w', task_type: 'monitor', description: 'watcher', ambient: true }] }),
      sys('task_notification', { task_id: 'fg', status: 'completed', output_file: '/tmp/o', summary: 'done' })
    ])
    expect(lists).toEqual([[]])
  })

  it('names task kinds', () => {
    expect(taskKind('local_bash')).toBe('shell')
    expect(taskKind('local_agent')).toBe('agent')
    expect(taskKind('local_workflow')).toBe('workflow')
    expect(taskKind('mcp_task')).toBe('mcp_task')
    expect(taskKind(undefined)).toBe('task')
  })
})
