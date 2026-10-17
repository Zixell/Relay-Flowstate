import { app } from 'electron'
import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type {
  AgentCapabilities,
  AgentEvent,
  AgentSession,
  ChatSupport,
  ExternalSessionInfo,
  FileDiff,
  HistoryEntry,
  PermissionOption,
  PlanItem,
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
 * Agents speaking the Agent Client Protocol (agentclientprotocol.com) over
 * stdio: Gemini CLI, OpenCode, Goose and others. One adapter, configured per
 * agent with the command that starts its ACP server.
 */

export interface AcpAgentSpec {
  /** Agent id in the registry; keys the cached capabilities. */
  id: string
  binary: string
  args: string[]
  /** Shown when the agent reports that it needs the user to sign in. */
  loginHint: string
}

const PROTOCOL_VERSION = 1

// --- ACP wire types (the subset this adapter reads) --------------------------

interface ContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

interface ToolCallContent {
  type: 'content' | 'diff' | 'terminal'
  content?: ContentBlock
  path?: string
  oldText?: string | null
  newText?: string
}

interface ToolCallFields {
  toolCallId: string
  title?: string | null
  name?: string | null
  kind?: string | null
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | null
  content?: ToolCallContent[] | null
  locations?: { path: string; line?: number | null }[] | null
  rawInput?: unknown
  rawOutput?: unknown
}

interface SessionUpdate {
  sessionUpdate: string
  entries?: { content: string; status: string }[]
  currentModeId?: string
  configOptions?: ConfigOption[]
  cost?: { amount: number; currency: string } | null
}

interface SelectOption {
  value: string
  name: string
}

interface ConfigOption {
  id: string
  name: string
  category?: string | null
  type: string
  currentValue: string | boolean
  options?: (SelectOption | { group: string; name: string; options: SelectOption[] })[]
}

interface ModeState {
  currentModeId: string
  availableModes: { id: string; name: string }[]
}

interface InitializeResult {
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean }
    sessionCapabilities?: { list?: object | null; fork?: object | null; resume?: object | null }
  }
}

// --- Capabilities cache --------------------------------------------------------
// Modes and models come from the agent at session start. They are cached on
// disk so the composer's pickers are filled before the first session runs.

type Choice = { id: string; label: string }
const cache = new Map<string, { modes?: Choice[]; models?: Choice[] }>()
let cacheLoaded = false

function cacheFile(): string | null {
  // `app` is undefined outside Electron (unit tests).
  return app ? join(app.getPath('userData'), 'acp-capabilities.json') : null
}

function loadCache(): void {
  if (cacheLoaded) return
  cacheLoaded = true
  const file = cacheFile()
  if (!file) return
  try {
    for (const [id, v] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) cache.set(id, v as never)
  } catch {
    // first run
  }
}

function saveCache(): void {
  const file = cacheFile()
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(Object.fromEntries(cache)))
  } catch (err) {
    console.warn('[relay][acp] could not save capabilities cache:', err)
  }
}

function flattenOptions(opt: ConfigOption): Choice[] {
  const out: Choice[] = []
  for (const o of opt.options ?? []) {
    if ('options' in o) for (const inner of o.options) out.push({ id: inner.value, label: inner.name })
    else out.push({ id: o.value, label: o.name })
  }
  return out
}

// --- Mapping -------------------------------------------------------------------

const KINDS: Record<string, ToolKind> = {
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'search',
  execute: 'bash',
  fetch: 'fetch',
  think: 'other',
  switch_mode: 'other',
  other: 'other'
}

function hasDetails(t: ToolCallFields): boolean {
  const input = t.rawInput
  const hasInput = input != null && (typeof input !== 'object' || Object.keys(input as object).length > 0)
  return hasInput || Boolean(t.content?.length)
}

interface ToolState extends ToolCallFields {
  started: boolean
  done: boolean
  diffs: Map<string, FileDiff>
  output?: string
  shownTitle?: string
  lastUpdate?: string
}

/** Turns ACP `session/update`s into normalized events. Shared by live sessions and history import. */
class AcpMapper {
  private hub = new EventHub()
  private buffer: { id: string; kind: 'text' | 'thinking'; text: string } | null = null
  private tools = new Map<string, ToolState>()
  plan: PlanItem[] = []
  costUsd?: number

  constructor(private rel: (p: string) => string) {}

  onEvent(cb: (e: AgentEvent) => void): () => void {
    return this.hub.on(cb)
  }

  emit(e: AgentEvent): void {
    this.hub.emit(e)
  }

  /** Ends the text or thought being streamed, so the next item starts a new message. */
  flush(): void {
    const b = this.buffer
    this.buffer = null
    if (!b) return
    if (b.kind === 'text') this.emit({ type: 'message.completed', messageId: b.id, text: b.text })
    else if (b.text.trim()) this.emit({ type: 'thinking', messageId: b.id, text: b.text })
  }

  private append(kind: 'text' | 'thinking', text: string): void {
    if (this.buffer && this.buffer.kind !== kind) this.flush()
    this.buffer ??= { id: randomUUID(), kind, text: '' }
    this.buffer.text += text
    if (kind === 'text') this.emit({ type: 'message.delta', messageId: this.buffer.id, text })
  }

  private title(t: ToolState): string {
    const kind = KINDS[t.kind ?? 'other'] ?? 'other'
    const input = (t.rawInput ?? {}) as Record<string, unknown>
    const path = t.locations?.[0]?.path
    if ((kind === 'read' || kind === 'edit') && path) return this.rel(path)
    if (kind === 'bash' && typeof input.command === 'string') return input.command
    return t.title || t.name || 'Tool'
  }

  private collect(t: ToolState, content: ToolCallContent[] | null | undefined): void {
    if (!content?.length) return
    const texts: string[] = []
    for (const c of content) {
      if (c.type === 'diff' && c.path) {
        t.diffs.set(c.path, { path: this.rel(c.path), oldText: c.oldText ?? '', newText: c.newText ?? '' })
      } else if (c.type === 'content' && c.content?.type === 'text' && c.content.text) {
        texts.push(c.content.text)
      }
    }
    if (texts.length) t.output = texts.join('\n')
  }

  private start(t: ToolState): void {
    t.started = true
    t.shownTitle = this.title(t)
    this.emit({
      type: 'tool.started',
      toolCallId: t.toolCallId,
      kind: KINDS[t.kind ?? 'other'] ?? 'other',
      name: t.name || t.kind || 'tool',
      title: t.shownTitle,
      input: t.rawInput ?? {}
    })
  }

  private complete(t: ToolState): void {
    if (t.done) return
    t.done = true
    const raw = typeof t.rawOutput === 'string' ? t.rawOutput : undefined
    this.emit({
      type: 'tool.completed',
      toolCallId: t.toolCallId,
      status: t.status === 'failed' ? 'error' : 'ok',
      output: t.output ?? raw,
      diff: t.diffs.size ? [...t.diffs.values()] : undefined
    })
  }

  /** Merges a tool call (from an update or a permission request) and emits what changed. */
  tool(fields: ToolCallFields, isNew: boolean): void {
    let t = this.tools.get(fields.toolCallId)
    if (!t) {
      t = { toolCallId: fields.toolCallId, started: false, done: false, diffs: new Map() }
      this.tools.set(fields.toolCallId, t)
    }
    for (const key of ['title', 'name', 'kind', 'status', 'locations'] as const) {
      if (fields[key] != null) (t as unknown as Record<string, unknown>)[key] = fields[key]
    }
    if (fields.rawInput !== undefined && hasDetails({ toolCallId: '', rawInput: fields.rawInput })) t.rawInput = fields.rawInput
    if (fields.rawOutput !== undefined) t.rawOutput = fields.rawOutput
    this.collect(t, fields.content)

    const settled = t.status === 'completed' || t.status === 'failed'
    if (!t.started) {
      // Agents often announce a call before its arguments are known; wait for them.
      if (hasDetails(t) || settled || (t.status && t.status !== 'pending') || !isNew) this.start(t)
    } else if (!t.done) {
      const update: AgentEvent = {
        type: 'tool.updated',
        toolCallId: t.toolCallId,
        kind: KINDS[t.kind ?? 'other'] ?? 'other',
        title: this.title(t),
        input: t.rawInput,
        diff: t.diffs.size ? [...t.diffs.values()] : undefined
      }
      // Agents resend unchanged fields; only real changes reach the database.
      const key = JSON.stringify(update)
      if (key !== t.lastUpdate) {
        t.lastUpdate = key
        t.shownTitle = update.title
        this.emit(update)
      }
    }
    if (t.started && settled) this.complete(t)
  }

  /** Makes sure a call the agent asks permission for has a card to attach to. */
  ensureStarted(fields: ToolCallFields): void {
    this.flush()
    this.tool(fields, false)
  }

  update(u: SessionUpdate): void {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const block = (u as unknown as { content: ContentBlock }).content
        if (block?.type === 'text' && block.text) this.append('text', block.text)
        return
      }
      case 'agent_thought_chunk': {
        const block = (u as unknown as { content: ContentBlock }).content
        if (block?.type === 'text' && block.text) this.append('thinking', block.text)
        return
      }
      case 'tool_call':
      case 'tool_call_update':
        this.flush()
        this.tool(u as unknown as ToolCallFields, u.sessionUpdate === 'tool_call')
        return
      case 'plan':
        this.plan = (u.entries ?? []).map((e) => ({
          text: e.content,
          status: e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'in_progress' : 'pending'
        }))
        this.emit({ type: 'plan.updated', items: this.plan })
        return
      case 'usage_update': {
        const usage = u as unknown as { used?: number; size?: number }
        if (u.cost?.currency === 'USD') this.costUsd = u.cost.amount
        this.emit({ type: 'usage.updated', usage: { contextUsed: usage.used, contextSize: usage.size, costUsd: this.costUsd } })
        return
      }
      case 'available_commands_update': {
        const list = (u as unknown as { availableCommands?: { name: string; description?: string; input?: { hint?: string } | null }[] }).availableCommands ?? []
        this.emit({
          type: 'commands.updated',
          commands: list.map((c) => ({ name: c.name, description: c.description || undefined, hint: c.input?.hint || undefined }))
        })
        return
      }
      default:
        return
    }
  }

  /** Tool calls still open when a turn ends were cut off. */
  closeOpenTools(): void {
    for (const t of this.tools.values()) {
      if (t.started && !t.done) {
        t.status = 'failed'
        t.output ??= 'Interrupted'
        this.complete(t)
      }
    }
    this.tools.clear()
  }
}

// --- Process ---------------------------------------------------------------------

async function startAgent(
  spec: AcpAgentSpec,
  cwd: string,
  handlers: Omit<RpcHandlers, 'onStderr'>
): Promise<{ rpc: JsonRpcProcess; init: InitializeResult }> {
  const executable = resolveExecutable(spec.binary)
  if (!executable) throw new Error(`${spec.binary} not found. Install it and make sure it is on your PATH.`)
  // npm-installed CLIs are node scripts; a GUI app's PATH may not contain node.
  const env = { ...process.env, PATH: `${dirname(executable)}:${process.env.PATH ?? ''}` }
  const rpc = new JsonRpcProcess(executable, spec.args, { cwd, env }, {
    ...handlers,
    onStderr: (text) => console.warn(`[relay][${spec.id}]`, text.trimEnd())
  })
  try {
    const init = await rpc.request<InitializeResult>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: 'relay', title: 'Relay', version: '1.0.0' }
    })
    return { rpc, init }
  } catch (err) {
    rpc.kill()
    throw err
  }
}

/** Client-side file access the agent may ask for. */
function handleFs(req: RpcRequest): unknown {
  const p = (req.params ?? {}) as { path?: string; content?: string; line?: number | null; limit?: number | null }
  if (!p.path) throw new RpcError('path is required', -32602)
  if (req.method === 'fs/read_text_file') {
    let text = readFileSync(p.path, 'utf8')
    if (p.line != null || p.limit != null) {
      const lines = text.split('\n')
      const start = Math.max(0, (p.line ?? 1) - 1)
      text = lines.slice(start, p.limit != null ? start + p.limit : undefined).join('\n')
    }
    return { content: text }
  }
  mkdirSync(dirname(p.path), { recursive: true })
  writeFileSync(p.path, p.content ?? '')
  return null
}

function withLoginHint(err: unknown, spec: AcpAgentSpec): Error {
  const message = err instanceof Error ? err.message : String(err)
  return /auth|login|sign.?in|credential|api key/i.test(message) ? new Error(`${message}. ${spec.loginHint}`) : new Error(message)
}

// --- Session ---------------------------------------------------------------------

interface PendingPermission {
  respond: (result: unknown) => void
  /** Our option id → the agent's. */
  options: Record<string, string>
}

class AcpSession implements AgentSession {
  private mapper: AcpMapper
  private rpc: JsonRpcProcess | null = null
  private init: InitializeResult = {}
  private sessionId: string | null = null
  private modeSource: { kind: 'config'; configId: string } | { kind: 'modes' } | null = null
  private modelConfigId: string | null = null
  private currentMode?: string
  private currentTurn: string | null = null
  private interruptRequested = false
  private queue: UserInput[] = []
  private permissions = new Map<string, PendingPermission>()
  /** Set while `session/load` replays history into a live session; those updates are not news. */
  private replaying = false
  private disposed = false

  constructor(
    private spec: AcpAgentSpec,
    private ctx: SessionContext
  ) {
    this.mapper = new AcpMapper(relativizer(ctx.cwd))
  }

  onEvent(cb: (e: AgentEvent) => void): () => void {
    return this.mapper.onEvent(cb)
  }

  private emit(e: AgentEvent): void {
    this.mapper.emit(e)
  }

  /** Reads modes and models the agent offers for this session and caches them. */
  private applyOptions(modes?: ModeState | null, configOptions?: ConfigOption[] | null): void {
    const entry = cache.get(this.spec.id) ?? {}
    const modeOpt = configOptions?.find((o) => o.category === 'mode' && o.type === 'select')
    if (modeOpt) {
      this.modeSource = { kind: 'config', configId: modeOpt.id }
      this.currentMode = String(modeOpt.currentValue)
      entry.modes = flattenOptions(modeOpt)
    } else if (modes?.availableModes?.length) {
      this.modeSource = { kind: 'modes' }
      this.currentMode = modes.currentModeId
      entry.modes = modes.availableModes.map((m) => ({ id: m.id, label: m.name }))
    }
    const modelOpt = configOptions?.find((o) => o.category === 'model' && o.type === 'select')
    if (modelOpt) {
      this.modelConfigId = modelOpt.id
      entry.models = [{ id: 'default', label: 'Default' }, ...flattenOptions(modelOpt)]
    }
    cache.set(this.spec.id, entry)
    saveCache()
  }

  async start(): Promise<void> {
    if (this.rpc) return
    const { rpc, init } = await startAgent(this.spec, this.ctx.cwd, {
      onNotification: (method, params) => {
        if (method !== 'session/update' || this.replaying) return
        const p = params as { sessionId: string; update: SessionUpdate }
        if (p.sessionId !== this.sessionId) return
        try {
          if (p.update.sessionUpdate === 'current_mode_update' && p.update.currentModeId) this.currentMode = p.update.currentModeId
          else if (p.update.sessionUpdate === 'config_option_update') this.applyOptions(null, p.update.configOptions)
          else this.mapper.update(p.update)
        } catch (err) {
          console.error(`[relay][${this.spec.id}] failed to handle update`, err)
        }
      },
      onRequest: (req) => this.onRequest(req),
      onExit: (code) => {
        if (this.disposed) return
        this.finishTurn('error')
        this.emit({ type: 'session.exited', code })
      }
    })
    this.rpc = rpc
    this.init = init
    const caps = init.agentCapabilities ?? {}
    const base = { cwd: this.ctx.cwd, mcpServers: [] }

    let opened: { modes?: ModeState | null; configOptions?: ConfigOption[] | null } | null = null
    const resumeId = this.ctx.resumeSessionId
    if (resumeId && (caps.sessionCapabilities?.resume || caps.loadSession)) {
      try {
        this.sessionId = resumeId
        if (caps.sessionCapabilities?.resume) {
          opened = await rpc.request('session/resume', { ...base, sessionId: resumeId })
        } else {
          this.replaying = true
          opened = await rpc.request('session/load', { ...base, sessionId: resumeId })
        }
      } catch (err) {
        console.warn(`[relay][${this.spec.id}] could not resume session, starting a new one:`, err)
        opened = null
      } finally {
        this.replaying = false
      }
    }
    if (!opened) {
      try {
        const r = await rpc.request<{ sessionId: string; modes?: ModeState | null; configOptions?: ConfigOption[] | null }>('session/new', base)
        this.sessionId = r.sessionId
        opened = r
      } catch (err) {
        rpc.kill()
        this.rpc = null
        throw withLoginHint(err, this.spec)
      }
    }
    this.applyOptions(opened.modes, opened.configOptions)

    if (this.ctx.mode && this.ctx.mode !== this.currentMode) await this.setMode(this.ctx.mode).catch(() => {})
    if (this.ctx.model && this.ctx.model !== 'default') await this.setModel(this.ctx.model).catch(() => {})
    this.emit({ type: 'session.started', sessionId: this.sessionId!, mode: this.currentMode, model: this.ctx.model ?? undefined })
  }

  private async onRequest(req: RpcRequest): Promise<unknown> {
    if (req.method === 'session/request_permission') return this.askPermission(req.params as never)
    if (req.method === 'fs/read_text_file' || req.method === 'fs/write_text_file') return handleFs(req)
    throw new RpcError(`Relay does not support ${req.method}`, -32601)
  }

  private askPermission(params: { toolCall: ToolCallFields; options: { optionId: string; name: string; kind: string }[] }): Promise<unknown> {
    this.mapper.ensureStarted(params.toolCall)
    const options: PermissionOption[] = []
    const map: Record<string, string> = {}
    const pick = (ours: PermissionOption['kind'], kinds: string[]): void => {
      const o = kinds.map((k) => params.options.find((x) => x.kind === k)).find(Boolean)
      if (!o) return
      map[ours] = o.optionId
      options.push({ id: ours, label: o.name, kind: ours })
    }
    pick('allow_once', ['allow_once'])
    pick('allow_always', ['allow_always'])
    pick('deny', ['reject_once', 'reject_always'])

    const requestId = randomUUID()
    return new Promise((respond) => {
      this.permissions.set(requestId, { respond, options: map })
      this.emit({
        type: 'permission.requested',
        requestId,
        toolCallId: params.toolCall.toolCallId,
        title: params.toolCall.title || 'Permission requested',
        options
      })
    })
  }

  respondPermission(requestId: string, optionId: string): void {
    const p = this.permissions.get(requestId)
    if (!p) return
    this.permissions.delete(requestId)
    const agentOption = p.options[optionId]
    p.respond(agentOption ? { outcome: { outcome: 'selected', optionId: agentOption } } : { outcome: { outcome: 'cancelled' } })
    this.emit({ type: 'permission.resolved', requestId, optionId })
  }

  private finishTurn(reason: TurnEndReason, usage?: TurnUsage): void {
    if (!this.currentTurn) return
    const turnId = this.currentTurn
    this.currentTurn = null
    this.interruptRequested = false
    this.mapper.flush()
    this.mapper.closeOpenTools()
    for (const [requestId, p] of this.permissions) {
      p.respond({ outcome: { outcome: 'cancelled' } })
      this.emit({ type: 'permission.resolved', requestId, optionId: 'deny' })
    }
    this.permissions.clear()
    this.emit({ type: 'turn.completed', turnId, reason, usage })
  }

  async send(input: UserInput): Promise<void> {
    if (!this.rpc) await this.start()
    // ACP has one prompt in flight per session; follow-ups wait for the turn to end.
    if (this.currentTurn) {
      this.queue.push(input)
      return
    }
    void this.runTurn(input)
  }

  private async runTurn(input: UserInput): Promise<void> {
    this.currentTurn = randomUUID()
    this.emit({ type: 'turn.started', turnId: this.currentTurn })

    const prompt: ContentBlock[] = []
    if (input.text.trim()) prompt.push({ type: 'text', text: input.text })
    const images = input.images ?? []
    if (images.length && this.init.agentCapabilities?.promptCapabilities?.image) {
      for (const img of images) prompt.push({ type: 'image', mimeType: img.mediaType, data: img.data })
    } else if (images.length) {
      this.emit({ type: 'error', message: 'This agent does not accept images; they were not sent.', fatal: false })
    }

    try {
      const r = await this.rpc!.request<{ stopReason: string; usage?: { inputTokens?: number; outputTokens?: number } | null }>(
        'session/prompt',
        { sessionId: this.sessionId, prompt }
      )
      let reason: TurnEndReason = 'end_turn'
      if (r.stopReason === 'cancelled' || this.interruptRequested) reason = 'interrupted'
      else if (r.stopReason === 'max_tokens' || r.stopReason === 'max_turn_requests') reason = 'max_tokens'
      else if (r.stopReason === 'refusal') {
        reason = 'error'
        this.emit({ type: 'error', message: 'The agent refused to continue.', fatal: false })
      }
      this.finishTurn(reason, {
        inputTokens: r.usage?.inputTokens,
        outputTokens: r.usage?.outputTokens,
        costUsd: this.mapper.costUsd
      })
    } catch (err) {
      if (this.disposed) return
      this.emit({ type: 'error', message: withLoginHint(err, this.spec).message, fatal: false })
      this.finishTurn(this.interruptRequested ? 'interrupted' : 'error')
    }

    const next = this.queue.shift()
    if (next && !this.disposed) void this.runTurn(next)
  }

  async interrupt(): Promise<void> {
    if (!this.rpc || !this.currentTurn) return
    this.interruptRequested = true
    this.queue = []
    this.rpc.notify('session/cancel', { sessionId: this.sessionId })
  }

  async setMode(mode: string): Promise<void> {
    if (!this.rpc || !this.sessionId) return
    if (this.modeSource?.kind === 'config') {
      await this.rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: this.modeSource.configId, value: mode })
    } else if (this.modeSource?.kind === 'modes') {
      await this.rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: mode })
    }
    this.currentMode = mode
  }

  async setModel(model: string): Promise<void> {
    if (!this.rpc || !this.sessionId || !this.modelConfigId || model === 'default') return
    await this.rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: this.modelConfigId, value: model })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const p of this.permissions.values()) p.respond({ outcome: { outcome: 'cancelled' } })
    this.permissions.clear()
    this.rpc?.kill()
    this.rpc = null
  }
}

// --- History (import) --------------------------------------------------------------

/** A short-lived agent process for one-off requests. */
async function withAgent<T>(spec: AcpAgentSpec, cwd: string, fn: (rpc: JsonRpcProcess, init: InitializeResult) => Promise<T>, onUpdate?: (u: SessionUpdate) => void): Promise<T> {
  const { rpc, init } = await startAgent(spec, cwd, {
    onNotification: (method, params) => {
      if (method === 'session/update') onUpdate?.((params as { update: SessionUpdate }).update)
    },
    onRequest: (req) => Promise.reject(new RpcError(`Not supported while importing: ${req.method}`, -32601)),
    onExit: () => {}
  })
  try {
    return await fn(rpc, init)
  } finally {
    rpc.kill()
  }
}

function acpHistory(spec: AcpAgentSpec): SessionHistory {
  return {
    async list() {
      return withAgent(spec, homedir(), async (rpc, init) => {
        if (!init.agentCapabilities?.sessionCapabilities?.list) return []
        const out: ExternalSessionInfo[] = []
        let cursor: string | null = null
        do {
          const page: { sessions: { sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }[]; nextCursor?: string | null } =
            await rpc.request('session/list', { cursor })
          for (const s of page.sessions) {
            out.push({
              sessionId: s.sessionId,
              title: s.title || 'Untitled session',
              cwd: s.cwd,
              updatedAt: s.updatedAt ? Date.parse(s.updatedAt) || 0 : 0
            })
          }
          cursor = page.nextCursor ?? null
        } while (cursor && out.length < 1000)
        return out
      })
    },

    async load(sessionId, cwd) {
      const entries: HistoryEntry[] = []
      const mapper = new AcpMapper(relativizer(cwd))
      mapper.onEvent((event) => entries.push({ type: 'event', event }))
      let user: { text: string; images: { mediaType: string; data: string }[] } | null = null
      const endUser = (): void => {
        if (user && (user.text.trim() || user.images.length)) entries.push({ type: 'user', ...user })
        user = null
      }
      await withAgent(
        spec,
        cwd,
        async (rpc, init) => {
          if (!init.agentCapabilities?.loadSession) throw new Error(`${spec.id} cannot replay saved sessions`)
          await rpc.request('session/load', { sessionId, cwd, mcpServers: [] })
        },
        (u) => {
          if (u.sessionUpdate === 'user_message_chunk') {
            mapper.flush()
            const block = (u as unknown as { content: ContentBlock }).content
            user ??= { text: '', images: [] }
            if (block?.type === 'text' && block.text) user.text += block.text
            if (block?.type === 'image' && block.data) user.images.push({ mediaType: block.mimeType ?? 'image/png', data: block.data })
            return
          }
          endUser()
          mapper.update(u)
        }
      )
      endUser()
      mapper.flush()
      mapper.closeOpenTools()
      return entries
    },

    async fork(sessionId, cwd) {
      return withAgent(spec, cwd, async (rpc, init) => {
        if (!init.agentCapabilities?.sessionCapabilities?.fork) throw new Error('This agent cannot copy sessions; import it without a worktree')
        const r = await rpc.request<{ sessionId: string }>('session/fork', { sessionId, cwd, mcpServers: [] })
        return r.sessionId
      })
    }
  }
}

export function createAcpChat(spec: AcpAgentSpec): ChatSupport {
  const capabilities: AgentCapabilities = {
    resume: true,
    interrupt: true,
    permissions: true,
    images: true,
    get models() {
      loadCache()
      return cache.get(spec.id)?.models
    },
    get modes() {
      loadCache()
      return cache.get(spec.id)?.modes
    }
  }
  return {
    capabilities,
    createSession: (ctx) => new AcpSession(spec, ctx),
    history: acpHistory(spec)
  }
}

export { AcpMapper as _AcpMapperForTests }
