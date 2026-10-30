import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../stores/appStore'
import { applyChatEvent, emptyChat, type ChatState } from '../stores/chatReducer'
import type { BackgroundTask, ChatEventPayload, ChatMessage, PlanItem, SessionUsage, SlashCommandInfo, TurnInfo } from '../types'

const isElectron = typeof window !== 'undefined' && !!window.api

export interface ChatHandle {
  state: ChatState
  turns: TurnInfo[]
  loading: boolean
  send: (text: string, images?: { mediaType: string; data: string }[]) => Promise<void>
  interrupt: () => Promise<void>
  respondPermission: (requestId: string, optionId: string, answers?: Record<string, string>) => Promise<void>
  refreshTurns: () => Promise<void>
}

/** History, live stream and actions of one chat-mode task. */
export function useChat(taskId: string): ChatHandle {
  const [state, setState] = useState<ChatState>(emptyChat)
  const [turns, setTurns] = useState<TurnInfo[]>([])
  const [loading, setLoading] = useState(true)
  const pending = useRef<ChatEventPayload[] | null>([])

  const refreshTurns = useCallback(async () => {
    if (!isElectron) return
    setTurns((await window.api.turns.list(taskId)) as TurnInfo[])
  }, [taskId])

  useEffect(() => {
    if (!isElectron) return
    let cancelled = false
    setState(emptyChat())
    setLoading(true)
    pending.current = []

    // Subscribe first so nothing streamed during the history load is lost.
    const unsub = window.api.chat.onEvent(taskId, (raw) => {
      const payload = raw as ChatEventPayload
      if (pending.current) pending.current.push(payload)
      else setState((s) => applyChatEvent(s, payload))
      if (payload.event.type === 'turn.completed') void refreshTurns()
      // The agent reports the mode it actually started in; keep the picker honest.
      if (payload.event.type === 'session.started') {
        const store = useAppStore.getState()
        if (payload.event.mode) store.updateTask(taskId, { mode: payload.event.mode })
        // ACP agents announce their modes and models only when a session opens.
        void store.loadAgents()
      }
    })

    // A run can end without a turn in the chat (e.g. a condition skipped it): settle the composer
    const unsubRuns = window.api.pipelines.onEvent(taskId, (e) => {
      if (e.type !== 'run.completed') return
      void window.api.chat.live(taskId).then((l: { inTurn?: boolean }) => {
        if (!cancelled) setState((s) => ({ ...s, inTurn: Boolean(l.inTurn) }))
      })
    })

    Promise.all([
      window.api.chat.history(taskId) as Promise<ChatMessage[]>,
      window.api.chat.live(taskId) as Promise<{
        active: boolean
        inTurn?: boolean
        streaming: Record<string, string>
        plan: PlanItem[]
        background?: BackgroundTask[]
        commands?: SlashCommandInfo[]
        usage?: SessionUsage | null
      }>
    ]).then(([messages, liveState]) => {
      if (cancelled) return
      let s: ChatState = {
        ...emptyChat(),
        messages,
        streaming: liveState.streaming,
        streamingOrder: Object.keys(liveState.streaming),
        plan: liveState.plan,
        background: liveState.background ?? [],
        commands: liveState.commands ?? [],
        usage: liveState.usage ?? null,
        costUsd: liveState.usage?.costUsd,
        inTurn: liveState.inTurn ?? Object.keys(liveState.streaming).length > 0
      }
      for (const p of pending.current ?? []) s = applyChatEvent(s, p)
      pending.current = null
      setState(s)
      setLoading(false)

      // No live session yet (imported chat, app restart): ask the agent for
      // commands and context without running a turn. Live events win.
      if (!liveState.active && (!s.commands.length || !s.usage)) {
        window.api.chat.peek(taskId).then((peek: { commands?: SlashCommandInfo[]; usage?: SessionUsage | null }) => {
          if (cancelled) return
          setState((cur) => ({
            ...cur,
            commands: cur.commands.length ? cur.commands : peek.commands ?? [],
            usage: cur.usage ?? peek.usage ?? null
          }))
        })
      }
    })
    void refreshTurns()

    return () => {
      cancelled = true
      unsub()
      unsubRuns()
    }
  }, [taskId, refreshTurns])

  const send = useCallback(
    async (text: string, images?: { mediaType: string; data: string }[]) => {
      setState((s) => ({ ...s, inTurn: true }))
      await window.api.chat.send(taskId, { text, images })
    },
    [taskId]
  )

  const interrupt = useCallback(async () => {
    await window.api.chat.interrupt(taskId)
  }, [taskId])

  const respondPermission = useCallback(
    async (requestId: string, optionId: string, answers?: Record<string, string>) => {
      await window.api.chat.respondPermission(taskId, requestId, optionId, answers)
    },
    [taskId]
  )

  return { state, turns, loading, send, interrupt, respondPermission, refreshTurns }
}
