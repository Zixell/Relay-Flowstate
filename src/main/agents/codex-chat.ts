import { randomUUID } from 'crypto'
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'path'
import type {
  AgentEvent,
  AgentSession,
  ChatSupport,
  ExternalSessionInfo,
  FileDiff,
  HistoryEntry,
  PermissionOption,
  PlanItem,
  RateLimitInfo,
  SessionContext,
  SessionHistory,
  ToolKind,
  TurnEndReason,
  TurnUsage,
  UserInput
} from './adapter'
import { EventHub } from './adapter'
import { JsonRpcProcess, RpcError, type RpcHandlers, type RpcRequest } from './jsonrpc'
import { resolveExecutable } from './resolve-executable'
import { relativizer } from './paths'

/**
 * Codex driven through `codex app-server`: JSON-RPC over stdio with threads,
 * turns and items. Schema: `codex app-server generate-ts`.
 */

/** Mode new sessions start in. */
export const CODEX_DEFAULT_MODE = 'CODEX_DEFAULT_MODE'
/** Old boolean setting: false meant "start in Auto (sandboxed)". */
export const LEGACY_CODEX_BYPASS_APPROVALS = 'CODEX_BYPASS_APPROVALS'

type ApprovalPolicy = 'untrusted' | 'on-request' | 'never'
type SandboxKind = 'readOnly' | 'workspaceWrite' | 'dangerFullAccess'

const MODES: { id: string; label: string; approval: ApprovalPolicy; sandbox: SandboxKind }[] = [
  { id: 'untrusted', label: 'Ask before acting', approval: 'untrusted', sandbox: 'workspaceWrite' },
  { id: 'auto', label: 'Auto (sandboxed)', approval: 'on-request', sandbox: 'workspaceWrite' },
  { id: 'read-only', label: 'Read only', approval: 'on-request', sandbox: 'readOnly' },
  { id: 'full-access', label: 'Full access', approval: 'never', sandbox: 'dangerFullAccess' }
]

export const CODEX_MODE_OPTIONS = MODES.map(({ id, label }) => ({ id, label }))

/**
 * The catalog depends on the account. Seeded from the CLI's own cache so the
 * picker is right before any session runs, then refreshed from `model/list`.
 */
let models: { id: string; label: string }[] = [{ id: 'default', label: 'Default' }, ...cachedModels()]

function cachedModels(): { id: string; label: string }[] {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8')) as {
      models?: { slug: string; display_name?: string; visibility?: string }[]
    }
    return (raw.models ?? []).filter((m) => m.visibility !== 'hide').map((m) => ({ id: m.slug, label: m.display_name ?? m.slug }))
  } catch {
    return []
  }
}

interface TokenBreakdown {
  inputTokens: number
  outputTokens: number
}

interface CommandAction {
  type: 'read' | 'listFiles' | 'search' | 'unknown'
  command: string
  path?: string | null
  query?: string | null
}

interface FileChange {
  path: string
  kind: { type: 'add' | 'delete' | 'update'; move_path?: string | null }
  diff: string
}

/** The subset of `ThreadItem` this adapter reads. */
interface Item {
  type: string
  id: string
  text?: string
  summary?: string[]
  content?: string[]
  command?: string
  commandActions?: CommandAction[]
  aggregatedOutput?: string | null
  exitCode?: number | null
  status?: string
  changes?: FileChange[]
  server?: string
  tool?: string
  arguments?: unknown
  result?: { content?: unknown[] } | null
  error?: { message: string } | null
  query?: string
  path?: string
  contentItems?: unknown[] | null
  success?: boolean | null
}

interface PendingApproval {
  respond: (result: unknown) => void
  decisions: { allow_once: unknown; allow_always?: unknown; deny: unknown }
  rpcId: string | number
}

interface RateWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

function rateLimit(w: RateWindow): RateLimitInfo {
  const mins = w.windowDurationMins ?? 0
  const label = mins === 300 ? '5-hour' : mins === 10080 ? 'Weekly' : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : mins ? `${Math.round(mins / 60)}-hour` : 'Usage'
  return {
    label,
    usedPercent: Math.round(w.usedPercent),
    resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined,
    status: w.usedPercent >= 100 ? 'blocked' : w.usedPercent >= 80 ? 'warning' : 'ok'
  }
}

/** `/bin/zsh -lc "ls -la"` → `ls -la` */
export function stripShell(command: string): string {
  const m = command.match(/^\S*\/(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/)
  if (!m) return command
  const body = m[1].trim()
  if ((body.startsWith('"') && body.endsWith('"')) || (body.startsWith("'") && body.endsWith("'"))) {
    return body.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
  }
  return body
}

function commandKind(actions: CommandAction[] | undefined): ToolKind {
  if (!actions?.length) return 'bash'
  if (actions.every((a) => a.type === 'read')) return 'read'
  if (actions.every((a) => a.type === 'search' || a.type === 'listFiles')) return 'search'
  return 'bash'
}

function textOf(blocks: unknown[] | null | undefined): string {
  return (blocks ?? [])
    .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
    .filter(Boolean)
    .join('\n')
}

/** Git keeps a worktree's index and refs in the main repo; the sandbox must allow writing there. */
function gitCommonDir(cwd: string): string | null {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf8', timeout: 5000 })
  if (r.status !== 0) return null
  const dir = r.stdout.trim()
  return dir ? (isAbsolute(dir) ? dir : resolve(cwd, dir)) : null
}

/** Spawns `codex app-server` and completes the initialize handshake. */
async function startAppServer(
  cwd: string,
  handlers: Omit<RpcHandlers, 'onStderr'>
): Promise<JsonRpcProcess> {
  const executable = resolveExecutable('codex')
  if (!executable) throw new Error('Codex CLI not found. Install it with `npm i -g @openai/codex` and run `codex login`.')
  // npm-installed codex is a node script; a GUI app's PATH may not contain node.
  const env = { ...process.env, PATH: `${dirname(executable)}${delimiter}${process.env.PATH ?? ''}` }
  const rpc = new JsonRpcProcess(executable, ['app-server'], { cwd, env }, {
    ...handlers,
    onStderr: (text) => console.warn('[relay][codex]', text.trimEnd())
  })
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'relay', title: 'Relay', version: '1.0.0' },
      capabilities: { experimentalApi: false, requestAttestation: false }
    })
  } catch (err) {
    rpc.kill()
    throw err
  }
  rpc.notify('initialized')
  return rpc
}

/** A short-lived app-server for one-off requests (listing, reading, forking threads). */
async function withAppServer<T>(fn: (rpc: JsonRpcProcess) => Promise<T>): Promise<T> {
  const rpc = await startAppServer(homedir(), {
    onNotification: () => {},
    onRequest: () => Promise.reject(new RpcError('Not supported', -32601)),
    onExit: () => {}
  })
  try {
    return await fn(rpc)
  } finally {
    rpc.kill()
  }
}

class CodexSession implements AgentSession {
  private hub = new EventHub()
  private rpc: JsonRpcProcess | null = null
  private threadId: string | null = null
  private mode: (typeof MODES)[number]
  private model: string | null
  /** Our turn id (snapshots, DB) and the Codex one (interrupt, steer). */
  private currentTurn: string | null = null
  private codexTurn: string | null = null
  private interruptRequested = false
  private usageTotal: TokenBreakdown = { inputTokens: 0, outputTokens: 0 }
  private usageAtTurnStart: TokenBreakdown = { inputTokens: 0, outputTokens: 0 }
  private approvals = new Map<string, PendingApproval>()
  private itemTitles = new Map<string, string>()
  private writableRoots: string[]
  private disposed = false
  private rel: (p: string) => string

  constructor(private ctx: SessionContext) {
    this.rel = relativizer(ctx.cwd)
    this.mode =
      MODES.find((m) => m.id === ctx.mode) ??
      MODES.find((m) => m.id === ctx.getSetting(CODEX_DEFAULT_MODE)) ??
      MODES.find((m) => m.id === 'full-access')!
    this.model = ctx.model && ctx.model !== 'default' ? ctx.model : null
    const common = gitCommonDir(ctx.cwd)
    this.writableRoots = common ? [common] : []
  }

  onEvent(cb: (e: AgentEvent) => void): () => void {
    return this.hub.on(cb)
  }

  private emit(e: AgentEvent): void {
    this.hub.emit(e)
  }

  private sandboxPolicy(): Record<string, unknown> {
    switch (this.mode.sandbox) {
      case 'readOnly':
        return { type: 'readOnly', networkAccess: false }
      case 'dangerFullAccess':
        return { type: 'dangerFullAccess' }
      default:
        return { type: 'workspaceWrite', writableRoots: this.writableRoots, networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    }
  }

  async start(): Promise<void> {
    if (this.rpc) return
    this.rpc = await startAppServer(this.ctx.cwd, {
      onNotification: (method, params) => {
        try {
          this.onNotification(method, params as Record<string, unknown>)
        } catch (err) {
          console.error('[relay][codex] failed to handle', method, err)
        }
      },
      onRequest: (req) => this.onRequest(req),
      onExit: (code) => {
        if (this.disposed) return
        this.finishTurn('error')
        this.emit({ type: 'session.exited', code })
      }
    })

    void this.rpc
      .request<{ data: { id: string; displayName: string; hidden: boolean }[] }>('model/list', {})
      .then((r) => {
        const visible = r.data.filter((m) => !m.hidden).map((m) => ({ id: m.id, label: m.displayName }))
        if (visible.length) models = [{ id: 'default', label: 'Default' }, ...visible]
      })
      .catch(() => {})

    const params = {
      cwd: this.ctx.cwd,
      model: this.model,
      approvalPolicy: this.mode.approval,
      sandbox: this.mode.sandbox === 'readOnly' ? 'read-only' : this.mode.sandbox === 'dangerFullAccess' ? 'danger-full-access' : 'workspace-write'
    }
    let thread: { id: string; model?: string | null } | null = null
    if (this.ctx.resumeSessionId) {
      try {
        const r = await this.rpc.request<{ thread: { id: string }; model: string }>('thread/resume', {
          ...params,
          threadId: this.ctx.resumeSessionId,
          excludeTurns: true
        })
        thread = { id: r.thread.id, model: r.model }
      } catch (err) {
        console.warn('[relay][codex] could not resume thread, starting a new one:', err)
      }
    }
    if (!thread) {
      const r = await this.rpc.request<{ thread: { id: string }; model: string }>('thread/start', params)
      thread = { id: r.thread.id, model: r.model }
    }
    this.threadId = thread.id
    this.emit({ type: 'session.started', sessionId: thread.id, model: thread.model ?? undefined, mode: this.mode.id })
  }

  // --- Agent → us -----------------------------------------------------------

  private onNotification(method: string, p: Record<string, unknown>): void {
    if (p.threadId && p.threadId !== this.threadId) return
    switch (method) {
      case 'turn/started': {
        const turn = p.turn as { id: string }
        this.codexTurn = turn.id
        return
      }

      case 'item/agentMessage/delta':
        this.emit({ type: 'message.delta', messageId: String(p.itemId), text: String(p.delta) })
        return

      case 'item/started':
        this.itemStarted(p.item as Item)
        return

      case 'item/completed':
        this.itemCompleted(p.item as Item)
        return

      case 'turn/plan/updated': {
        const steps = (p.plan as { step: string; status: string }[]) ?? []
        const items: PlanItem[] = steps.map((s) => ({
          text: s.step,
          status: s.status === 'completed' ? 'done' : s.status === 'inProgress' ? 'in_progress' : 'pending'
        }))
        this.emit({ type: 'plan.updated', items })
        return
      }

      case 'thread/tokenUsage/updated': {
        const usage = p.tokenUsage as { total: TokenBreakdown; last: TokenBreakdown & { totalTokens: number }; modelContextWindow: number | null }
        this.usageTotal = { inputTokens: usage.total.inputTokens, outputTokens: usage.total.outputTokens }
        this.emit({
          type: 'usage.updated',
          usage: { contextUsed: usage.last.totalTokens, contextSize: usage.modelContextWindow ?? undefined }
        })
        return
      }

      case 'account/rateLimits/updated': {
        const snap = p.rateLimits as { primary: RateWindow | null; secondary: RateWindow | null }
        const limits = [snap.primary, snap.secondary].filter((w): w is RateWindow => Boolean(w)).map(rateLimit)
        if (limits.length) this.emit({ type: 'usage.updated', usage: { limits } })
        return
      }

      case 'serverRequest/resolved': {
        // Codex withdrew a prompt on its own (turn interrupted, etc.).
        for (const [requestId, a] of this.approvals) {
          if (a.rpcId !== p.requestId) continue
          this.approvals.delete(requestId)
          this.emit({ type: 'permission.resolved', requestId, optionId: 'deny' })
        }
        return
      }

      case 'error':
        if (!p.willRetry) this.emit({ type: 'error', message: (p.error as { message: string }).message, fatal: false })
        return

      case 'turn/completed': {
        const turn = p.turn as { status: string; error: { message: string } | null; durationMs: number | null }
        let reason: TurnEndReason = 'end_turn'
        if (turn.status === 'interrupted' || this.interruptRequested) reason = 'interrupted'
        else if (turn.status === 'failed') {
          reason = 'error'
          if (turn.error) this.emit({ type: 'error', message: turn.error.message, fatal: false })
        }
        this.finishTurn(reason, {
          inputTokens: this.usageTotal.inputTokens - this.usageAtTurnStart.inputTokens,
          outputTokens: this.usageTotal.outputTokens - this.usageAtTurnStart.outputTokens,
          durationMs: turn.durationMs ?? undefined
        })
        return
      }

      default:
        return
    }
  }

  private itemStarted(item: Item): void {
    switch (item.type) {
      case 'commandExecution': {
        const command = stripShell(item.command ?? '')
        const kind = commandKind(item.commandActions)
        const first = item.commandActions?.[0]
        const title =
          kind === 'read' && first?.path ? this.rel(first.path) : kind === 'search' && first?.query ? first.query : command
        this.itemTitles.set(item.id, command)
        this.emit({ type: 'tool.started', toolCallId: item.id, kind, name: 'shell', title, input: { command } })
        return
      }
      case 'fileChange': {
        const changes = item.changes ?? []
        const kind: ToolKind = changes.length && changes.every((c) => c.kind.type === 'add') ? 'write' : 'edit'
        const title = changes.map((c) => this.rel(c.path)).join(', ') || 'files'
        this.itemTitles.set(item.id, title)
        this.emit({ type: 'tool.started', toolCallId: item.id, kind, name: 'apply_patch', title, input: { changes: changes.map((c) => this.rel(c.path)) } })
        return
      }
      case 'mcpToolCall': {
        const title = `${item.server} · ${item.tool}`
        this.itemTitles.set(item.id, title)
        this.emit({ type: 'tool.started', toolCallId: item.id, kind: 'mcp', name: String(item.tool), title, input: item.arguments ?? {} })
        return
      }
      case 'dynamicToolCall':
        this.emit({ type: 'tool.started', toolCallId: item.id, kind: 'other', name: String(item.tool), title: String(item.tool), input: item.arguments ?? {} })
        return
      case 'webSearch':
        this.emit({ type: 'tool.started', toolCallId: item.id, kind: 'fetch', name: 'web_search', title: item.query || 'Web search', input: {} })
        return
      default:
        return
    }
  }

  private itemCompleted(item: Item): void {
    switch (item.type) {
      case 'agentMessage':
      case 'plan':
        this.emit({ type: 'message.completed', messageId: item.id, text: item.text ?? '' })
        return
      case 'reasoning': {
        const text = (item.summary?.length ? item.summary : item.content ?? []).join('\n\n')
        if (text.trim()) this.emit({ type: 'thinking', messageId: item.id, text })
        return
      }
      case 'commandExecution': {
        const failed = item.status !== 'completed' || (item.exitCode != null && item.exitCode !== 0)
        const output = item.status === 'declined' ? 'Declined' : item.aggregatedOutput ?? undefined
        this.emit({ type: 'tool.completed', toolCallId: item.id, status: failed ? 'error' : 'ok', output })
        return
      }
      case 'fileChange': {
        const ok = item.status === 'completed'
        const diff: FileDiff[] = (item.changes ?? []).map((c) => {
          const path = this.rel(c.path)
          // Added and deleted files come as their full text, updates as a unified diff.
          if (c.kind.type === 'add') return { path, oldText: '', newText: c.diff }
          if (c.kind.type === 'delete') return { path, oldText: c.diff, newText: '' }
          return { path, patch: c.diff }
        })
        this.emit({ type: 'tool.completed', toolCallId: item.id, status: ok ? 'ok' : 'error', output: ok ? undefined : item.status, diff: ok ? diff : undefined })
        return
      }
      case 'mcpToolCall':
        this.emit({
          type: 'tool.completed',
          toolCallId: item.id,
          status: item.error ? 'error' : 'ok',
          output: item.error?.message ?? textOf(item.result?.content)
        })
        return
      case 'dynamicToolCall':
        this.emit({ type: 'tool.completed', toolCallId: item.id, status: item.success === false ? 'error' : 'ok', output: textOf(item.contentItems) })
        return
      case 'webSearch':
        this.emit({ type: 'tool.completed', toolCallId: item.id, status: 'ok' })
        return
      default:
        return
    }
  }

  /** Feeds a stored, finished item through the live mapping (history import). */
  replayItem(item: unknown): void {
    this.itemStarted(item as Item)
    this.itemCompleted(item as Item)
  }

  private onRequest(req: RpcRequest): Promise<unknown> {
    const p = (req.params ?? {}) as Record<string, unknown>
    switch (req.method) {
      case 'item/commandExecution/requestApproval': {
        const available = (p.availableDecisions as unknown[] | undefined) ?? ['accept', 'acceptForSession', 'decline', 'cancel']
        const amendment = available.find((d) => typeof d === 'object' && d && 'acceptWithExecpolicyAmendment' in d)
        const command = p.command ? stripShell(String(p.command)) : this.itemTitles.get(String(p.itemId)) ?? 'command'
        return this.ask(req.id, {
          toolCallId: String(p.itemId),
          title: `Run: ${command}`,
          detail: (p.reason as string | undefined) ?? undefined,
          decisions: {
            allow_once: 'accept',
            allow_always: amendment ?? (available.includes('acceptForSession') ? 'acceptForSession' : undefined),
            deny: available.includes('decline') ? 'decline' : 'cancel'
          }
        })
      }
      case 'item/fileChange/requestApproval':
        return this.ask(req.id, {
          toolCallId: String(p.itemId),
          title: `Edit: ${this.itemTitles.get(String(p.itemId)) ?? 'files'}`,
          detail: (p.reason as string | undefined) ?? undefined,
          decisions: { allow_once: 'accept', allow_always: 'acceptForSession', deny: 'decline' }
        })
      default:
        // Prompts the chat UI has no form for yet (user input, MCP elicitation, …).
        return Promise.reject(new RpcError(`Relay does not support ${req.method}`, -32601))
    }
  }

  private ask(
    rpcId: string | number,
    req: { toolCallId: string; title: string; detail?: string; decisions: PendingApproval['decisions'] }
  ): Promise<unknown> {
    const requestId = randomUUID()
    const options: PermissionOption[] = [{ id: 'allow_once', label: 'Allow', kind: 'allow_once' }]
    if (req.decisions.allow_always) options.push({ id: 'allow_always', label: 'Always allow', kind: 'allow_always' })
    options.push({ id: 'deny', label: 'Deny', kind: 'deny' })
    return new Promise((respond) => {
      this.approvals.set(requestId, { respond, decisions: req.decisions, rpcId })
      this.emit({ type: 'permission.requested', requestId, toolCallId: req.toolCallId, title: req.title, detail: req.detail, options })
    })
  }

  respondPermission(requestId: string, optionId: string): void {
    const a = this.approvals.get(requestId)
    if (!a) return
    this.approvals.delete(requestId)
    const decision = optionId === 'allow_always' ? a.decisions.allow_always : optionId === 'deny' ? a.decisions.deny : a.decisions.allow_once
    a.respond({ decision: decision ?? a.decisions.allow_once })
    this.emit({ type: 'permission.resolved', requestId, optionId })
  }

  private finishTurn(reason: TurnEndReason, usage?: TurnUsage): void {
    if (!this.currentTurn) return
    const turnId = this.currentTurn
    const checkpoint = this.codexTurn ?? undefined
    this.currentTurn = null
    this.codexTurn = null
    this.interruptRequested = false
    for (const [requestId, a] of this.approvals) {
      a.respond({ decision: 'cancel' })
      this.emit({ type: 'permission.resolved', requestId, optionId: 'deny' })
    }
    this.approvals.clear()
    this.itemTitles.clear()
    this.emit({ type: 'turn.completed', turnId, reason, usage, checkpoint })
  }

  // --- Us → agent -----------------------------------------------------------

  async send(input: UserInput): Promise<void> {
    if (!this.rpc) await this.start()
    const rpc = this.rpc!
    const content: Record<string, unknown>[] = []
    if (input.text.trim()) content.push({ type: 'text', text: input.text, text_elements: [] })
    for (const img of input.images ?? []) content.push({ type: 'image', url: `data:${img.mediaType};base64,${img.data}` })

    // A follow-up during a running turn joins it instead of queueing a new one.
    if (this.currentTurn && this.codexTurn) {
      try {
        await rpc.request('turn/steer', { threadId: this.threadId, input: content, expectedTurnId: this.codexTurn })
        return
      } catch {
        // The turn ended in the meantime — start a new one below.
      }
    }

    if (!this.currentTurn) {
      this.currentTurn = randomUUID()
      this.usageAtTurnStart = { ...this.usageTotal }
      this.emit({ type: 'turn.started', turnId: this.currentTurn })
    }
    try {
      const r = await rpc.request<{ turn: { id: string } }>('turn/start', {
        threadId: this.threadId,
        input: content,
        model: this.model,
        approvalPolicy: this.mode.approval,
        sandboxPolicy: this.sandboxPolicy()
      })
      this.codexTurn ??= r.turn.id
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err), fatal: false })
      this.finishTurn('error')
    }
  }

  async interrupt(): Promise<void> {
    if (!this.rpc || !this.currentTurn || !this.codexTurn) return
    this.interruptRequested = true
    await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.codexTurn }).catch(() => {})
  }

  /** Applied from the next turn on — Codex takes the policy per turn. */
  async setMode(mode: string): Promise<void> {
    const next = MODES.find((m) => m.id === mode)
    if (next) this.mode = next
  }

  async setModel(model: string): Promise<void> {
    this.model = model === 'default' ? null : model
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const a of this.approvals.values()) a.respond({ decision: 'cancel' })
    this.approvals.clear()
    this.rpc?.kill()
    this.rpc = null
  }
}

interface StoredThread {
  id: string
  name: string | null
  preview: string
  cwd: string
  createdAt: number
  updatedAt: number
  gitInfo?: { branch?: string | null } | null
  turns?: { items: Item[] }[]
}

function imageFromDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = url.match(/^data:([^;]+);base64,(.*)$/)
  return m ? { mediaType: m[1], data: m[2] } : null
}

const codexHistory: SessionHistory = {
  async list() {
    return withAppServer(async (rpc) => {
      const out: ExternalSessionInfo[] = []
      let cursor: string | null = null
      do {
        const page: { data: StoredThread[]; nextCursor: string | null } = await rpc.request('thread/list', { limit: 100, cursor })
        for (const t of page.data) {
          out.push({
            sessionId: t.id,
            title: t.name || t.preview || 'Untitled session',
            cwd: t.cwd,
            createdAt: t.createdAt * 1000,
            updatedAt: t.updatedAt * 1000,
            gitBranch: t.gitInfo?.branch ?? undefined
          })
        }
        cursor = page.nextCursor
      } while (cursor && out.length < 1000)
      return out
    })
  },

  async load(sessionId, cwd) {
    const { thread } = await withAppServer((rpc) =>
      rpc.request<{ thread: StoredThread }>('thread/read', { threadId: sessionId, includeTurns: true })
    )
    const entries: HistoryEntry[] = []
    const mapper = new CodexSession({ taskId: 'import', cwd, getSetting: () => '' })
    mapper.onEvent((event) => entries.push({ type: 'event', event }))
    for (const turn of thread.turns ?? []) {
      for (const item of turn.items) {
        if (item.type !== 'userMessage') {
          mapper.replayItem(item)
          continue
        }
        const content = ((item as { content?: Record<string, unknown>[] }).content ?? [])
        const text = content.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n\n')
        const images = content
          .filter((c) => c.type === 'image' && typeof c.url === 'string')
          .map((c) => imageFromDataUrl(c.url as string))
          .filter((i): i is { mediaType: string; data: string } => i !== null)
        if (text.trim() || images.length) entries.push({ type: 'user', text, images })
      }
    }
    return entries
  },

  async fork(sessionId, _cwd, upTo) {
    const r = await withAppServer((rpc) =>
      rpc.request<{ thread: { id: string } }>('thread/fork', { threadId: sessionId, lastTurnId: upTo ?? null })
    )
    return r.thread.id
  }
}

export const codexChat: ChatSupport = {
  capabilities: {
    resume: true,
    interrupt: true,
    permissions: true,
    images: true,
    forkFromTurn: true,
    get models() {
      return models
    },
    modes: MODES.map(({ id, label }) => ({ id, label })),
    limits: true
  },
  createSession: (ctx) => new CodexSession(ctx),
  history: codexHistory,
  readLimits: () =>
    withAppServer(async (rpc) => {
      const res = (await rpc.request('account/rateLimits/read', {})) as {
        rateLimits?: { primary: RateWindow | null; secondary: RateWindow | null } | null
      }
      const snap = res.rateLimits
      return snap ? [snap.primary, snap.secondary].filter((w): w is RateWindow => Boolean(w)).map(rateLimit) : null
    })
}
