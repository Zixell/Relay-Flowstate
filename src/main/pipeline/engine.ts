import { evaluate } from './conditions'
import { isAgentTurn, isRouted, sessionOf, type GraphAnalysis } from './graph'
import { render, type TemplateScope } from './template'
import { validate } from './validate'
import type { PipelineEdge, PipelineGraph, PipelineNode, RunBudget, RunEvent, RunStatus, StepOutput } from './types'

export type { RunEvent }

/** Executes one block. Templates in the block are already filled in. */
export interface StepRunner {
  run(node: PipelineNode, ctx: StepContext, signal: AbortSignal): Promise<StepOutput>
}

export interface StepContext {
  runId: string
  stepId: string
  input: string
  /** Latest output of every block that has run so far. */
  steps: Record<string, StepOutput>
  /** How many times this block ran before in this run. */
  activation: number
}

export interface RunOptions {
  runId: string
  input: string
  runner: StepRunner
  onEvent?: (event: RunEvent) => void
}

export interface RunResult {
  status: RunStatus
  error?: string
  steps: Record<string, StepOutput>
}

/**
 * One run of a pipeline — BPMN-style tokens over the graph.
 *
 * A finished block fires its plain arrows plus the first matching conditional
 * arrow (or the default); each fired arrow activates its target. A block runs
 * once per arriving token, a Join once all branches that can still reach it
 * have arrived. Blocks on the task's session take turns; back-arrows count
 * their rounds. Semantics: docs/pipeline-design.md.
 */
export class PipelineRun {
  private readonly a: GraphAnalysis
  private readonly budget: RunBudget
  /** Agent turns started and dollars spent so far, against the budget. */
  private turns = 0
  private cost = 0
  private readonly abort = new AbortController()
  private status: RunStatus = 'running'
  private error?: string
  private readonly outputs: Record<string, StepOutput> = {}
  /** Activations queued or running, per block. */
  private readonly active = new Map<string, number>()
  private pending = 0
  private readonly activations = new Map<string, number>()
  /** Runs of the same block go one after another. */
  private readonly nodeQueues = new Map<string, Promise<void>>()
  /** The task's session takes one turn at a time. */
  private sessionQueue: Promise<void> = Promise.resolve()
  private readonly joinArrivals = new Map<string, Set<string>>()
  private readonly loopRounds = new Map<string, number>()
  private readonly reachCache = new Map<string, Map<string, Set<string>>>()
  private done!: (result: RunResult) => void
  private readonly finished = new Promise<RunResult>((resolve) => (this.done = resolve))
  private started = false
  private settled = false

  constructor(
    graph: PipelineGraph,
    private readonly opts: RunOptions
  ) {
    const result = validate(graph)
    const first = result.issues.find((i) => i.level === 'error')
    if (first) throw new Error(`Pipeline is invalid: ${first.message}`)
    this.a = result.analysis
    this.budget = graph.budget ?? {}
  }

  start(): Promise<RunResult> {
    if (!this.started) {
      this.started = true
      this.emit({ type: 'run.started', runId: this.opts.runId })
      this.activate(this.a.entry!)
    }
    return this.finished
  }

  /** Stops the run: running blocks get an abort signal, queued ones never start. */
  cancel(): void {
    this.stop('cancelled')
  }

  private emit(event: RunEvent): void {
    this.opts.onEvent?.(event)
  }

  private stop(status: 'cancelled' | 'failed', error?: string): void {
    if (this.status !== 'running') return
    this.status = status
    this.error = error
    this.abort.abort()
    this.settle()
  }

  private activate(nodeId: string): void {
    this.pending++
    this.active.set(nodeId, (this.active.get(nodeId) ?? 0) + 1)
    const prev = this.nodeQueues.get(nodeId) ?? Promise.resolve()
    this.nodeQueues.set(nodeId, prev.then(() => this.execute(nodeId)))
  }

  private async execute(nodeId: string): Promise<void> {
    try {
      if (this.status !== 'running') return
      const node = this.a.nodes.get(nodeId)!
      const output =
        node.type === 'join'
          ? await this.runJoin(node)
          : sessionOf(node) === 'current'
            ? await this.inSession(() => this.runStep(node))
            : await this.runStep(node)
      if (output && this.status === 'running') this.route(nodeId, output)
    } finally {
      this.active.set(nodeId, this.active.get(nodeId)! - 1)
      this.pending--
      this.checkJoins()
      this.settle()
    }
  }

  private async inSession<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionQueue
    let release!: () => void
    this.sessionQueue = new Promise((r) => (release = r))
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private begin(node: PipelineNode): { stepId: string; activation: number } {
    const activation = this.activations.get(node.id) ?? 0
    this.activations.set(node.id, activation + 1)
    const stepId = `${this.opts.runId}:${node.id}:${activation}`
    this.emit({ type: 'step.started', runId: this.opts.runId, stepId, nodeId: node.id, activation })
    return { stepId, activation }
  }

  private complete(nodeId: string, stepId: string, output: StepOutput): StepOutput {
    this.outputs[nodeId] = output
    this.emit({ type: 'step.completed', runId: this.opts.runId, stepId, nodeId, output })
    return output
  }

  private async runJoin(node: PipelineNode): Promise<StepOutput> {
    const { stepId } = this.begin(node)
    return this.complete(node.id, stepId, { status: 'ok', output: '' })
  }

  /** Undefined when the run stopped while the block was running. */
  private async runStep(node: PipelineNode): Promise<StepOutput | undefined> {
    if (this.status !== 'running') return undefined
    if (isAgentTurn(node)) {
      const over = this.overBudget()
      if (over) {
        this.stop('failed', over)
        return undefined
      }
      this.turns++
    }
    const { stepId, activation } = this.begin(node)
    const ctx: StepContext = { runId: this.opts.runId, stepId, input: this.opts.input, steps: { ...this.outputs }, activation }
    let output: StepOutput
    try {
      output = await this.opts.runner.run(fill(node, { input: this.opts.input, steps: ctx.steps }), ctx, this.abort.signal)
    } catch (err) {
      output = { status: 'error', output: '', error: err instanceof Error ? err.message : String(err) }
    }
    this.cost += output.costUsd ?? 0
    if (this.status !== 'running') return undefined
    return this.complete(node.id, stepId, output)
  }

  /** Why the next agent turn may not start, if it may not. */
  private overBudget(): string | null {
    const { maxTurns, maxCostUsd } = this.budget
    if (maxTurns !== undefined && this.turns >= maxTurns) return `Budget reached: ${maxTurns} agent turn${maxTurns > 1 ? 's' : ''}`
    if (maxCostUsd !== undefined && this.cost >= maxCostUsd) return `Budget reached: $${this.cost.toFixed(2)} of $${maxCostUsd.toFixed(2)}`
    return null
  }

  private route(nodeId: string, out: StepOutput): void {
    const edges = this.a.outgoing.get(nodeId)!
    const routed = edges
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => isRouted(e))
      .sort((x, y) => (x.e.order ?? Infinity) - (y.e.order ?? Infinity) || x.i - y.i)
      .map(({ e }) => e)
    const match = routed.find((e) => e.condition && evaluate(e.condition, out))
    let fired: PipelineEdge[]
    if (out.status === 'error') {
      // A failed block goes on only along an arrow that handles the failure
      fired = match ? [match] : []
      if (!fired.length) {
        const name = this.a.nodes.get(nodeId)!.label || nodeId
        return this.stop('failed', `"${name}" failed${out.error ? `: ${out.error}` : ''}`)
      }
    } else {
      const chosen = match ?? routed.find((e) => e.isDefault)
      fired = [...edges.filter((e) => !isRouted(e)), ...(chosen ? [chosen] : [])]
    }
    for (const e of fired) {
      if (this.a.backEdges.has(e.id)) {
        const next = this.nextRound(e)
        if (next === 'failed') return
        if (next === 'redirected') continue
      }
      this.send(e)
    }
  }

  /** Counts a round of the loop `e` closes, or handles its limit. */
  private nextRound(e: PipelineEdge): 'go' | 'redirected' | 'failed' {
    const rounds = this.loopRounds.get(e.id) ?? 0
    if (rounds >= (e.maxIterations ?? 0)) {
      this.emit({ type: 'loop.exhausted', runId: this.opts.runId, edgeId: e.id })
      if (e.onExhausted?.kind === 'goto') {
        this.activate(e.onExhausted.nodeId)
        return 'redirected'
      }
      this.stop('failed', `Loop limit reached (${e.maxIterations} iterations)`)
      return 'failed'
    }
    this.loopRounds.set(e.id, rounds + 1)
    // A new round of this loop starts the loops inside it from scratch
    const body = this.a.loops.get(e.id)!.body
    for (const inner of this.a.loops.values()) {
      if (inner.edgeId !== e.id && inner.body.size < body.size && [...inner.body].every((n) => body.has(n))) {
        this.loopRounds.delete(inner.edgeId)
      }
    }
    return 'go'
  }

  private send(e: PipelineEdge): void {
    if (this.a.nodes.get(e.to)!.type !== 'join') return this.activate(e.to)
    const arrived = this.joinArrivals.get(e.to) ?? new Set<string>()
    arrived.add(e.id)
    this.joinArrivals.set(e.to, arrived)
  }

  /** Fires every Join whose missing branches can no longer arrive. */
  private checkJoins(): void {
    if (this.status !== 'running') return
    for (const [joinId, arrived] of this.joinArrivals) {
      if (!arrived.size) continue
      const waiting = this.a.incoming.get(joinId)!.filter((e) => !arrived.has(e.id))
      if (waiting.some((e) => this.canStillRun(e.from, joinId))) continue
      this.joinArrivals.set(joinId, new Set())
      this.activate(joinId)
    }
  }

  /** Whether a queued or running block leads to `nodeId` without passing the Join. */
  private canStillRun(nodeId: string, joinId: string): boolean {
    for (const [id, count] of this.active) {
      if (count > 0 && id !== joinId && this.reach(joinId, id).has(nodeId)) return true
    }
    return false
  }

  private reach(joinId: string, from: string): Set<string> {
    let byJoin = this.reachCache.get(joinId)
    if (!byJoin) this.reachCache.set(joinId, (byJoin = new Map()))
    let set = byJoin.get(from)
    if (!set) {
      set = new Set([from])
      const queue = [from]
      while (queue.length) {
        for (const e of this.a.flow.get(queue.shift()!)!) {
          if (e.to === joinId || set.has(e.to)) continue
          set.add(e.to)
          queue.push(e.to)
        }
      }
      byJoin.set(from, set)
    }
    return set
  }

  private settle(): void {
    if (this.pending > 0 || this.settled) return
    this.settled = true
    if (this.status === 'running') this.status = 'completed'
    this.emit({ type: 'run.completed', runId: this.opts.runId, status: this.status, error: this.error })
    this.done({ status: this.status, error: this.error, steps: { ...this.outputs } })
  }
}

/** The block with its templates filled in. Shell commands are left as written — no agent text in a command line. */
function fill(node: PipelineNode, scope: TemplateScope): PipelineNode {
  switch (node.type) {
    case 'anchor':
      return { ...node, prompt: render(node.prompt ?? '{{input}}', scope) }
    case 'agent':
    case 'prompt':
      return { ...node, prompt: render(node.prompt, scope) }
    case 'tool':
      return { ...node, args: fillDeep(node.args, scope) as Record<string, unknown> }
    case 'action':
      if (node.action === 'commit') return { ...node, message: node.message && render(node.message, scope) }
      if (node.action === 'notify') return { ...node, message: render(node.message, scope) }
      return node
    default:
      return node
  }
}

function fillDeep(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === 'string') return render(value, scope)
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, scope))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, scope)]))
  }
  return value
}
