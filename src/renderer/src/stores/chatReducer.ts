import type { BackgroundTask, ChatEventPayload, ChatMessage, PlanItem, SessionUsage, SlashCommandInfo } from '../types'

export interface ChatState {
  /** Persisted messages ordered by seq. */
  messages: ChatMessage[]
  /** Text streamed so far for messages that are not persisted yet, by message id. */
  streaming: Record<string, string>
  /** Order in which streaming messages started, so they render in place. */
  streamingOrder: string[]
  plan: PlanItem[]
  /** Background tasks of the live session: running ones and those that ended. */
  background: BackgroundTask[]
  inTurn: boolean
  /** Running session cost reported by the agent. */
  costUsd?: number
  sessionModel?: string
  commands: SlashCommandInfo[]
  /** Context fill, cost and plan limits, merged from partial reports. */
  usage: SessionUsage | null
  /** The agent's guess at the next message, offered as ghost text until a new turn starts. */
  suggestion: string | null
}

export const emptyChat = (): ChatState => ({
  messages: [],
  streaming: {},
  streamingOrder: [],
  plan: [],
  background: [],
  inTurn: false,
  commands: [],
  usage: null,
  suggestion: null
})

/** Inserts or replaces a message, keeping seq order. */
export function upsertMessage(messages: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const i = messages.findIndex((m) => m.id === msg.id)
  if (i >= 0) {
    const next = messages.slice()
    next[i] = msg
    return next
  }
  const last = messages[messages.length - 1]
  if (!last || last.seq < msg.seq) return [...messages, msg]
  return [...messages, msg].sort((a, b) => a.seq - b.seq)
}

export function applyChatEvent(state: ChatState, { event, message }: ChatEventPayload): ChatState {
  let next = message ? { ...state, messages: upsertMessage(state.messages, message) } : state

  switch (event.type) {
    case 'session.started':
      return {
        ...next,
        sessionModel: event.model,
        // Names only until the agent sends the full list.
        commands: next.commands.length ? next.commands : (event.slashCommands ?? []).map((name) => ({ name }))
      }
    case 'commands.updated':
      return { ...next, commands: event.commands }
    case 'usage.updated': {
      const usage: SessionUsage = { ...next.usage }
      for (const [k, v] of Object.entries(event.usage)) if (v !== undefined) (usage as Record<string, unknown>)[k] = v
      return { ...next, usage, costUsd: usage.costUsd ?? next.costUsd }
    }
    case 'turn.started':
      return { ...next, inTurn: true, suggestion: null }
    case 'prompt.suggested':
      return { ...next, suggestion: event.text }
    case 'message.delta': {
      const known = event.messageId in next.streaming
      return {
        ...next,
        streaming: { ...next.streaming, [event.messageId]: (next.streaming[event.messageId] ?? '') + event.text },
        streamingOrder: known ? next.streamingOrder : [...next.streamingOrder, event.messageId]
      }
    }
    case 'message.completed': {
      if (!(event.messageId in next.streaming)) return next
      const { [event.messageId]: _done, ...rest } = next.streaming
      next = { ...next, streaming: rest, streamingOrder: next.streamingOrder.filter((id) => id !== event.messageId) }
      return next
    }
    case 'plan.updated':
      return { ...next, plan: event.items }
    case 'background.updated':
      return { ...next, background: event.tasks }
    case 'turn.completed':
      return {
        ...next,
        inTurn: false,
        streaming: {},
        streamingOrder: [],
        costUsd: event.usage?.costUsd ?? next.costUsd
      }
    case 'session.exited':
      // Background work dies with the agent's process, subagents included
      return {
        ...next,
        inTurn: false,
        streaming: {},
        streamingOrder: [],
        background: [],
        messages: next.messages.map((m) => (m.kind === 'tool_call' && m.tool_status === 'running' ? { ...m, tool_status: 'error' } : m))
      }
    default:
      return next
  }
}
