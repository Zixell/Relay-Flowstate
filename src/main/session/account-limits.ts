import type { RateLimitInfo } from '../agents/adapter'
import { getAgent } from '../agents'
import { getSetting, setSetting } from '../settings'

/**
 * Plan limits (5-hour, weekly) per agent account. Any chat that hears about
 * them updates this, so Settings can show them while no agent is running;
 * Refresh asks the agent's CLI directly.
 */

const KEY = 'RELAY_ACCOUNT_LIMITS'

export interface AccountLimits {
  limits: RateLimitInfo[]
  /** When these were last reported, ms since epoch. */
  updatedAt: number
}

function load(): Record<string, AccountLimits> {
  try {
    return JSON.parse(getSetting(KEY) || '{}') as Record<string, AccountLimits>
  } catch {
    return {}
  }
}

export function getAccountLimits(): Record<string, AccountLimits> {
  return load()
}

/** Merges limits a chat reported; windows it did not mention keep their last value. */
export function recordLimits(agentId: string, limits: RateLimitInfo[], replace = false): AccountLimits {
  const all = load()
  const byLabel = new Map((replace ? [] : (all[agentId]?.limits ?? [])).map((l) => [l.label, l]))
  for (const l of limits) byLabel.set(l.label, l)
  const entry = { limits: [...byLabel.values()], updatedAt: Date.now() }
  all[agentId] = entry
  setSetting(KEY, JSON.stringify(all))
  return entry
}

/** Asks the agent's CLI for its current limits; null when it cannot tell. */
export async function refreshLimits(agentId: string): Promise<AccountLimits | null> {
  const read = getAgent(agentId).chat?.readLimits
  if (!read) return null
  const limits = await read().catch((err) => {
    console.warn(`[relay] reading ${agentId} limits failed:`, err)
    return null
  })
  return limits ? recordLimits(agentId, limits, true) : null
}
