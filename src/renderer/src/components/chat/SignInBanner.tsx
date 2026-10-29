import React from 'react'
import { LogIn } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { processLabel, type ChatMessage } from '../../types'

const AUTH_FAILURE =
  /not logged in|please run \/login|\/login isn't available|failed to authenticate|authentication[_ ]failed|(oauth|access) (session|token)[^.]*(expired|revoked|invalid)|invalid (x-)?api[ _-]?key|not authenticated|unauthorized|\b401\b|login required|sign in again|(codex|opencode auth) login/i

/**
 * Whether the conversation ended on the agent's account not being signed in.
 * Replies are only considered when short: a long one may just discuss auth.
 */
export function needsSignIn(last: Pick<ChatMessage, 'kind' | 'role' | 'content'> | undefined): boolean {
  if (!last?.content || last.role === 'user') return false
  if (last.kind === 'error') return AUTH_FAILURE.test(last.content)
  return last.kind === 'text' && last.content.length < 300 && AUTH_FAILURE.test(last.content)
}

/** Offers the in-app sign-in when the agent stopped for lack of one. */
export function SignInBanner({ agentId }: { agentId: string }) {
  const agents = useAppStore((s) => s.agents)
  const openSignIn = useAppStore((s) => s.openSignIn)
  const agent = agents.find((a) => a.id === agentId)
  if (!agent?.loginMethods.length) return null
  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[12px]">
      <span className="text-amber-300">{processLabel(agentId, agents)} needs you to sign in.</span>
      <button
        onClick={() => openSignIn(agentId)}
        className="ml-auto flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 text-[11.5px] font-medium text-zinc-900 hover:bg-zinc-200"
      >
        <LogIn className="w-3 h-3" />
        Sign in
      </button>
    </div>
  )
}
