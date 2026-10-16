import type { AgentEvent } from '../agents/adapter'

export type TaskStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'paused' | 'pending'

export interface StatusState {
  status: TaskStatus
  /** True while a turn is in flight — an exit during a turn is a failure. */
  inTurn: boolean
  /** Permission requests the user has not answered yet. */
  pendingPermissions: number
}

export function initialStatusState(status: TaskStatus = 'pending'): StatusState {
  return { status, inTurn: false, pendingPermissions: 0 }
}

/**
 * Derives a task's status from the agent's event stream.
 *
 * Replaces the terminal-mode inactivity heuristic: every transition is driven
 * by an explicit protocol event, so there are no timers and no status locks.
 */
export function reduceStatus(state: StatusState, event: AgentEvent): StatusState {
  switch (event.type) {
    case 'turn.started':
      return { status: 'running', inTurn: true, pendingPermissions: 0 }

    case 'permission.requested':
      return { ...state, status: 'waiting', pendingPermissions: state.pendingPermissions + 1 }

    case 'permission.resolved': {
      const pending = Math.max(0, state.pendingPermissions - 1)
      return { ...state, pendingPermissions: pending, status: pending > 0 ? 'waiting' : state.inTurn ? 'running' : state.status }
    }

    case 'turn.completed': {
      const status: TaskStatus =
        event.reason === 'interrupted' ? 'paused' : event.reason === 'error' ? 'failed' : 'completed'
      return { status, inTurn: false, pendingPermissions: 0 }
    }

    case 'error':
      return event.fatal ? { status: 'failed', inTurn: false, pendingPermissions: 0 } : state

    case 'session.exited':
      // Exiting between turns is a normal shutdown; mid-turn it means the run broke.
      if (!state.inTurn) return state
      return { status: event.code === 0 ? 'paused' : 'failed', inTurn: false, pendingPermissions: 0 }

    default:
      return state
  }
}
