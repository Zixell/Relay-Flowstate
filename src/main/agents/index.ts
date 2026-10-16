export type {
  AgentId,
  AgentCommand,
  AgentDefinition,
  AgentDescriptor,
  AgentSettingDef,
  HeadlessCommand,
  LaunchContext,
  PromptDelivery,
  SessionDiscovery
} from './types'

export {
  listAgents,
  getAgent,
  describeAgents,
  isAgentAvailable,
  getBoolSetting,
  resolveSummaryAgent,
  FALLBACK_AGENT
} from './registry'

export { resolveLaunch, sanitizeArgForShell } from './launcher'
export type { BuildLaunchOptions, ResolvedLaunch, ResumeMode } from './launcher'
export { watchForNewSession, UUID_RE_SOURCE } from './session-watcher'
