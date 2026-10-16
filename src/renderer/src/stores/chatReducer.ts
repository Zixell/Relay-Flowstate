import type { ChatEventPayload, ChatMessage, PlanItem } from '../types'

export interface ChatState {
  /** Persisted messages ordered by seq. */
  messages: ChatMessage[]
  /** Text streamed so far for messages that are not persisted yet, by message id. */
  streaming: Record<string, string>
  /** Order in which streaming messages started, so they render in place. */
  streamingOrder: string[]
  plan: PlanItem[]
  inTurn: boolean
  /** Running session cost reported by the agent. */
  costUsd?: number
  sessionModel?: string
  slashCommands: string[]
}

export const emptyChat = (): ChatState => ({
  messages: [],
  streaming: {},
  streamingOrder: [],
  plan: [],
  inTurn: false,
  slashCommands: []
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
      return { ...next, sessionModel: event.model, slashCommands: event.slashCommands ?? next.slashCommands }
    case 'turn.started':
      return { ...next, inTurn: true }
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
    case 'turn.completed':
      return {
        ...next,
        inTurn: false,
        streaming: {},
        streamingOrder: [],
        costUsd: event.usage?.costUsd ?? next.costUsd
      }
    case 'session.exited':
      return { ...next, inTurn: false, streaming: {}, streamingOrder: [] }
    default:
      return next
  }
}
