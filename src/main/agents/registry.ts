import { spawnSync } from 'child_process'
import { getSetting } from '../settings'
import type { AgentDefinition, AgentDescriptor, AgentId } from './types'
import { claudeCodeAgent } from './claude-code'
import { codexAgent } from './codex'
import { aiderAgent, genericAgent } from './others'
import { geminiAgent, openCodeAgent, gooseAgent } from './acp-agents'

/**
 * The agent catalog. Registration order is the order shown in the UI.
 * To add an agent: create a definition file next to this one and append it here.
 */
const AGENTS: AgentDefinition[] = [
  claudeCodeAgent,
  codexAgent,
  geminiAgent,
  openCodeAgent,
  gooseAgent,
  aiderAgent,
  genericAgent
]

const byId = new Map<AgentId, AgentDefinition>(AGENTS.map((a) => [a.id, a]))

/** Fallback used when a task references an agent that no longer exists. */
export const FALLBACK_AGENT = genericAgent

export function listAgents(): AgentDefinition[] {
  return AGENTS
}

export function getAgent(id: AgentId | undefined | null): AgentDefinition {
  return (id && byId.get(id)) || FALLBACK_AGENT
}

/** Reads a boolean app setting, honouring the agent-declared default. */
export function getBoolSetting(key: string, fallback: boolean): boolean {
  const raw = getSetting(key)
  if (raw === '') return fallback
  return raw !== 'false'
}

// --- CLI availability -------------------------------------------------------
// Probing spawns a process, so results are cached briefly. The cache is short
// enough that installing an agent while the app runs is picked up quickly.

const AVAILABILITY_TTL_MS = 60_000
const availabilityCache = new Map<AgentId, { value: boolean; checkedAt: number }>()

export function isAgentAvailable(id: AgentId, force = false): boolean {
  const cached = availabilityCache.get(id)
  if (!force && cached && Date.now() - cached.checkedAt < AVAILABILITY_TTL_MS) {
    return cached.value
  }

  const agent = byId.get(id)
  let value = false
  if (agent) {
    try {
      const result = spawnSync(agent.binary, agent.versionArgs, {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        shell: true
      })
      value = result.status === 0
    } catch {
      value = false
    }
  }

  availabilityCache.set(id, { value, checkedAt: Date.now() })
  return value
}

/** Serializable catalog for the renderer. */
export function describeAgents(): AgentDescriptor[] {
  return AGENTS.map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
    color: a.color,
    enabled: a.enabled,
    available: a.enabled ? isAgentAvailable(a.id) : false,
    supportsResume: typeof a.buildResumeCommand === 'function',
    supportsSummaries: Boolean(a.headless),
    chat: a.chat?.capabilities,
    settings: a.settings
  }))
}

/**
 * Picks an agent whose CLI can generate summaries. Prefers the task's own
 * agent, then any other installed agent — so a Codex task still gets an
 * AI-written summary on a machine that only has `claude`, and vice versa.
 */
export function resolveSummaryAgent(preferredId: AgentId): AgentDefinition | null {
  const preferred = byId.get(preferredId)
  if (preferred?.headless && isAgentAvailable(preferred.id)) return preferred

  for (const agent of AGENTS) {
    if (agent.headless && isAgentAvailable(agent.id)) return agent
  }
  return null
}
