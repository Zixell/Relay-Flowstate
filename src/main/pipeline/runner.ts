import { spawn } from 'child_process'
import type { AgentEvent, AgentSession, TurnEndReason, UserInput } from '../agents/adapter'
import type { StepContext, StepRunner } from './engine'
import type { AgentNode, PipelineNode, StepOutput } from './types'

/** How a turn ended — the task's own or a step's session. */
export interface TurnOutcome {
  reason: TurnEndReason
  texts: string[]
  changedFiles: string[]
  error?: string
  sessionId?: string
}

/** What the runner needs from the app; injected so it can be tested without agents. */
export interface RunnerDeps {
  /** The task's agent, for steps that do not choose one. */
  agentId: string
  cwd: string
  /** Images the user attached to the message — they go with the anchor. */
  images?: UserInput['images']
  /** A turn in the task's session; `show` puts the prompt into the chat. */
  runTurn(input: UserInput, opts: { show: boolean; signal: AbortSignal }): Promise<TurnOutcome>
  openSession(agentId: string): AgentSession
  /** Every event of a step's own session — permission prompts must reach the user. */
  onSideEvent(session: AgentSession, e: AgentEvent): void
  /** Called once a step's own session is done. */
  onSideClosed(session: AgentSession): void
  /** Snapshot of the worktree; null outside git. */
  snapshot(label: string): string | null
  changedFiles(from: string, to: string): string[]
  commit(message: string): StepOutput
  notify(message: string): void
}

const MAX_OUTPUT = 20_000

export function createRunner(deps: RunnerDeps): StepRunner {
  return {
    async run(node: PipelineNode, ctx: StepContext, signal: AbortSignal): Promise<StepOutput> {
      switch (node.type) {
        case 'anchor':
          return fromTurn(await deps.runTurn({ text: node.prompt ?? ctx.input, images: deps.images }, { show: false, signal }))
        case 'prompt':
          return fromTurn(await deps.runTurn({ text: node.prompt }, { show: true, signal }))
        case 'agent':
          if (node.session === 'current') {
            return fromTurn(await deps.runTurn({ text: withSchema(node) }, { show: true, signal }), node.outputSchema !== undefined)
          }
          return fromTurn(await runInNewSession(deps, node, ctx, signal), node.outputSchema !== undefined)
        case 'action':
          if (node.action === 'commit') return deps.commit(node.message?.trim() || 'Pipeline commit')
          if (node.action === 'notify') {
            deps.notify(node.message)
            return { status: 'ok', output: node.message }
          }
          return runShell(node.command, deps.cwd, shellEnv(ctx), signal)
        case 'tool':
          return { status: 'error', output: '', error: 'Direct MCP tool calls are not supported yet' }
        case 'join':
          return { status: 'ok', output: '' }
      }
    }
  }
}

function fromTurn(t: TurnOutcome, needsJson = false): StepOutput {
  const output = t.texts.at(-1) ?? ''
  const json = extractJson(t.texts)
  const base = { output, json, changedFiles: t.changedFiles, sessionId: t.sessionId }
  if (t.reason === 'end_turn') {
    if (needsJson && json === undefined) return { ...base, status: 'error', error: 'The answer has no JSON block' }
    return { ...base, status: 'ok' }
  }
  const error = t.reason === 'interrupted' ? 'Interrupted' : t.reason === 'max_tokens' ? 'The answer was cut off' : (t.error ?? 'The turn failed')
  return { ...base, status: 'error', error }
}

/** Asks for the answer in a JSON block when the step declared a schema. */
export function withSchema(node: AgentNode): string {
  if (!node.outputSchema) return node.prompt
  return `${node.prompt}\n\nEnd your answer with a JSON object matching this JSON schema, in a \`\`\`json code block:\n\`\`\`json\n${JSON.stringify(node.outputSchema, null, 2)}\n\`\`\``
}

/** The last ```json block of the latest message that has one; or a message that is JSON as a whole. */
export function extractJson(texts: string[]): unknown {
  for (let i = texts.length - 1; i >= 0; i--) {
    const blocks = [...texts[i].matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1])
    for (const candidate of [...blocks.reverse(), texts[i]]) {
      try {
        return JSON.parse(candidate.trim())
      } catch {
        // not JSON
      }
    }
  }
  return undefined
}

async function runInNewSession(deps: RunnerDeps, node: AgentNode, ctx: StepContext, signal: AbortSignal): Promise<TurnOutcome> {
  const label = `pipeline-${ctx.stepId}`.replace(/[^\w.-]/g, '-')
  const before = deps.snapshot(`${label}-before`)
  const session = deps.openSession(node.agent ?? deps.agentId)
  const texts: string[] = []
  let sessionId: string | undefined
  let lastError: string | undefined
  let unsubscribe = (): void => {}
  const ended = new Promise<Pick<TurnOutcome, 'reason' | 'error'>>((resolve) => {
    unsubscribe = session.onEvent((e) => {
      deps.onSideEvent(session, e)
      if (e.type === 'session.started') sessionId = e.sessionId
      else if (e.type === 'message.completed' && e.text.trim()) texts.push(e.text)
      else if (e.type === 'error') lastError = e.message
      else if (e.type === 'turn.completed') resolve({ reason: e.reason, error: lastError })
      else if (e.type === 'session.exited') resolve({ reason: 'error', error: lastError ?? 'The agent exited' })
    })
    signal.addEventListener('abort', () => resolve({ reason: 'interrupted' }), { once: true })
  })
  try {
    if (signal.aborted) return { reason: 'interrupted', texts, changedFiles: [] }
    await session.start()
    await session.send({ text: withSchema(node) })
    const end = await ended
    const after = deps.snapshot(`${label}-after`)
    const changedFiles = before && after ? deps.changedFiles(before, after) : []
    return { ...end, texts, changedFiles, sessionId }
  } catch (err) {
    return { reason: 'error', texts, changedFiles: [], error: err instanceof Error ? err.message : String(err), sessionId }
  } finally {
    unsubscribe()
    deps.onSideClosed(session)
    await session.dispose().catch(() => {})
  }
}

/** Earlier outputs reach a command through the environment, never through its text. */
function shellEnv(ctx: StepContext): Record<string, string> {
  const env: Record<string, string> = { PIPELINE_INPUT: ctx.input }
  for (const [id, out] of Object.entries(ctx.steps)) {
    const key = `PIPELINE_${id.toUpperCase().replace(/\W/g, '_')}`
    env[`${key}_OUTPUT`] = out.output
    env[`${key}_STATUS`] = out.status
    if (out.json !== undefined) env[`${key}_JSON`] = JSON.stringify(out.json)
  }
  return env
}

function runShell(command: string, cwd: string, env: Record<string, string>, signal: AbortSignal): Promise<StepOutput> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...process.env, ...env }, signal })
    let output = ''
    const collect = (chunk: Buffer): void => {
      if (output.length < MAX_OUTPUT) output += chunk.toString()
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (err) => resolve({ status: 'error', output, error: err.message }))
    child.on('close', (code) => {
      const text = output.length >= MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + '\n…(truncated)' : output
      resolve(
        code === 0
          ? { status: 'ok', output: text, exitCode: 0 }
          : { status: 'error', output: text, exitCode: code ?? undefined, error: `Exited with code ${code}` }
      )
    })
  })
}
