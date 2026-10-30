import { describe, expect, it } from 'vitest'
import { PipelineRun, type RunEvent, type StepContext } from './engine'
import { agent, anchor, edge, graph, join, otherwise, say, verdict, when } from './__fixtures__/graphs'
import type { PipelineGraph, PipelineNode, StepOutput } from './types'

type Script = (node: PipelineNode, ctx: StepContext, signal: AbortSignal) => StepOutput | Promise<StepOutput>

/** Runs a graph with a scripted runner; every block answers "ok" unless the script says otherwise. */
function run(g: PipelineGraph, script: Record<string, Script> = {}, input = 'hello') {
  const log: string[] = []
  const prompts: Record<string, string[]> = {}
  const events: RunEvent[] = []
  let running = 0
  let maxParallel = 0
  const r = new PipelineRun(g, {
    runId: 'r1',
    input,
    onEvent: (e) => events.push(e),
    runner: {
      async run(node, ctx, signal) {
        log.push(node.id)
        if ('prompt' in node && node.prompt !== undefined) (prompts[node.id] ??= []).push(node.prompt)
        running++
        maxParallel = Math.max(maxParallel, running)
        try {
          await tick()
          return (await script[node.id]?.(node, ctx, signal)) ?? { status: 'ok', output: `${node.id} done` }
        } finally {
          running--
        }
      }
    }
  })
  return { r, result: r.start(), log, prompts, events, maxParallel: () => maxParallel }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const json = (value: unknown): StepOutput => ({ status: 'ok', output: JSON.stringify(value), json: value })
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  return { promise: new Promise((r) => (resolve = r)), resolve }
}

/** The classic loop: review, fix and review again, commit when it passes. */
const reviewLoop = (max: number, onExhausted?: { kind: 'goto'; nodeId: string }): PipelineGraph =>
  graph(
    [anchor(), agent('review'), say('fix', 'Fix: {{review.json.issues}}'), agent('commit'), ...(onExhausted ? [agent('notify')] : [])],
    [
      edge('anchor', 'review'),
      when('review', 'commit', verdict('pass')),
      otherwise('review', 'fix'),
      edge('fix', 'review', { maxIterations: max, onExhausted })
    ]
  )

describe('PipelineRun', () => {
  it('refuses an invalid graph', () => {
    expect(() => new PipelineRun(graph([agent('a')]), { runId: 'x', input: '', runner: { run: async () => json(null) } })).toThrow(
      /Input prompt/
    )
  })

  it('runs a chain and fills templates from earlier blocks', async () => {
    const g = graph([anchor(), agent('a', 'new', 'got {{anchor.output}} for {{input}}')], [edge('anchor', 'a')])
    const { result, log, prompts } = run(g)
    expect((await result).status).toBe('completed')
    expect(log).toEqual(['anchor', 'a'])
    expect(prompts).toEqual({ anchor: ['hello'], a: ['got anchor done for hello'] })
  })

  it('runs pre-blocks first and feeds them into the anchor', async () => {
    const g = graph([agent('jira'), anchor('anchor', '{{input}}\n\nContext: {{jira}}')], [edge('jira', 'anchor')])
    const { result, log, prompts } = run(g, { jira: () => ({ status: 'ok', output: 'TASK-1' }) })
    await result
    expect(log).toEqual(['jira', 'anchor'])
    expect(prompts.anchor).toEqual(['hello\n\nContext: TASK-1'])
  })

  it('takes the first matching conditional arrow in order, else the default', async () => {
    const g = graph(
      [anchor(), agent('review'), agent('a'), agent('b'), agent('c')],
      [
        edge('anchor', 'review'),
        when('review', 'b', { kind: 'output', path: 'json.score', op: 'gt', value: 5 }, 2),
        when('review', 'a', verdict('pass'), 1),
        otherwise('review', 'c')
      ]
    )
    // Both conditions hold — the lower order wins
    const both = run(g, { review: () => json({ verdict: 'pass', score: 9 }) })
    await both.result
    expect(both.log).toEqual(['anchor', 'review', 'a'])

    const none = run(g, { review: () => json({ verdict: 'fail', score: 1 }) })
    await none.result
    expect(none.log).toEqual(['anchor', 'review', 'c'])
  })

  it('runs plain arrows in parallel', async () => {
    const g = graph([anchor(), agent('push'), agent('docs')], [edge('anchor', 'push'), edge('anchor', 'docs')])
    const gate = deferred()
    const { result, log, maxParallel } = run(g, {
      push: async () => {
        await gate.promise
        return json(null)
      },
      docs: async () => {
        gate.resolve()
        return json(null)
      }
    })
    expect((await result).status).toBe('completed')
    expect(log.sort()).toEqual(['anchor', 'docs', 'push'])
    expect(maxParallel()).toBe(2)
  })

  it('loops until the review passes', async () => {
    const verdicts = ['fail', 'fail', 'pass']
    const { result, log, prompts } = run(reviewLoop(3), {
      review: () => json({ verdict: verdicts.shift(), issues: ['naming'] })
    })
    expect((await result).status).toBe('completed')
    expect(log).toEqual(['anchor', 'review', 'fix', 'review', 'fix', 'review', 'commit'])
    expect(prompts.fix).toEqual(['Fix: naming', 'Fix: naming'])
  })

  it('fails the run when a loop runs out of iterations', async () => {
    const { result, log, events } = run(reviewLoop(2), { review: () => json({ verdict: 'fail' }) })
    const res = await result
    expect(res).toMatchObject({ status: 'failed', error: 'Loop limit reached (2 iterations)' })
    expect(log.filter((n) => n === 'review')).toHaveLength(3)
    expect(events).toContainEqual({ type: 'loop.exhausted', runId: 'r1', edgeId: 'fix->review' })
  })

  it('leaves an exhausted loop for the chosen block', async () => {
    const { result, log } = run(reviewLoop(1, { kind: 'goto', nodeId: 'notify' }), { review: () => json({ verdict: 'fail' }) })
    expect((await result).status).toBe('completed')
    expect(log).toEqual(['anchor', 'review', 'fix', 'review', 'fix', 'notify'])
  })

  it('restarts the counter of an inner loop on every round of the outer one', async () => {
    // outer: implement → test ⟲ fixTest → review ⟲ implement
    const g = graph(
      [anchor(), agent('implement'), agent('test'), agent('fixTest'), agent('review'), agent('done')],
      [
        edge('anchor', 'implement'),
        edge('implement', 'test'),
        when('test', 'review', verdict('pass')),
        otherwise('test', 'fixTest'),
        edge('fixTest', 'test', { maxIterations: 1 }),
        when('review', 'done', verdict('pass')),
        edge('review', 'implement', { isDefault: true, maxIterations: 2 })
      ]
    )
    const tests = ['fail', 'pass', 'fail', 'pass']
    const reviews = ['fail', 'pass']
    const { result, log } = run(g, {
      test: () => json({ verdict: tests.shift() }),
      review: () => json({ verdict: reviews.shift() })
    })
    expect((await result).status).toBe('completed')
    expect(log.filter((n) => n === 'fixTest')).toHaveLength(2)
    expect(log.at(-1)).toBe('done')
  })

  it('joins parallel branches once both arrive', async () => {
    const g = graph(
      [anchor(), agent('push'), agent('docs'), join('both'), agent('notify')],
      [edge('anchor', 'push'), edge('anchor', 'docs'), edge('push', 'both'), edge('docs', 'both'), edge('both', 'notify')]
    )
    const slow = deferred()
    const { result, log } = run(g, {
      push: async () => {
        await slow.promise
        return json(null)
      },
      docs: async () => {
        setTimeout(slow.resolve, 5)
        return json(null)
      }
    })
    await result
    expect(log.indexOf('notify')).toBe(log.length - 1)
    expect(log.filter((n) => n === 'notify')).toHaveLength(1)
  })

  it('does not wait at a Join for a branch a condition cut off', async () => {
    const g = graph(
      [anchor(), agent('check'), agent('a'), agent('b'), join('j'), agent('after')],
      [
        edge('anchor', 'check'),
        when('check', 'a', verdict('a')),
        otherwise('check', 'b'),
        edge('a', 'j'),
        edge('b', 'j'),
        edge('j', 'after')
      ]
    )
    const { result, log } = run(g, { check: () => json({ verdict: 'a' }) })
    expect((await result).status).toBe('completed')
    expect(log).toEqual(['anchor', 'check', 'a', 'after'])
  })

  it('runs a block reached by two branches without a Join once per branch, one at a time', async () => {
    const g = graph(
      [anchor(), agent('push'), agent('docs'), say('report')],
      [edge('anchor', 'push'), edge('anchor', 'docs'), edge('push', 'report'), edge('docs', 'report')]
    )
    let inReport = 0
    let overlap = false
    const { result, log } = run(g, {
      report: async () => {
        overlap ||= inReport > 0
        inReport++
        await tick()
        inReport--
        return json(null)
      }
    })
    await result
    expect(log.filter((n) => n === 'report')).toHaveLength(2)
    expect(overlap).toBe(false)
  })

  it('fails the run on an unhandled error and stops the other branches', async () => {
    const g = graph([anchor(), agent('push'), agent('docs')], [edge('anchor', 'push'), edge('anchor', 'docs')])
    let aborted = false
    const { result } = run(g, {
      push: () => {
        throw new Error('rejected')
      },
      docs: (_n, _c, signal) =>
        new Promise((resolve) => {
          const stop = (): void => {
            aborted = true
            resolve(json(null))
          }
          if (signal.aborted) stop()
          else signal.addEventListener('abort', stop)
        })
    })
    expect(await result).toMatchObject({ status: 'failed', error: '"push" failed: rejected' })
    expect(aborted).toBe(true)
  })

  it('goes on along an arrow that handles the failure', async () => {
    const g = graph(
      [anchor(), agent('push'), agent('retry'), agent('next')],
      [edge('anchor', 'push'), when('push', 'retry', { kind: 'status', equals: 'error' }), otherwise('push', 'next')]
    )
    const { result, log } = run(g, { push: () => ({ status: 'error', output: '', error: 'no remote' }) })
    expect((await result).status).toBe('completed')
    expect(log).toEqual(['anchor', 'push', 'retry'])
  })

  it('cancels: the running block is aborted, nothing after it starts', async () => {
    const g = graph([anchor(), agent('long'), agent('after')], [edge('anchor', 'long'), edge('long', 'after')])
    const started = deferred()
    const { r, result, log } = run(g, {
      long: (_n, _c, signal) =>
        new Promise((resolve) => {
          started.resolve()
          signal.addEventListener('abort', () => resolve(json(null)))
        })
    })
    await started.promise
    r.cancel()
    expect((await result).status).toBe('cancelled')
    expect(log).toEqual(['anchor', 'long'])
  })

  it('reports the run through events', async () => {
    const { result, events } = run(graph([anchor()]))
    await result
    expect(events.map((e) => e.type)).toEqual(['run.started', 'step.started', 'step.completed', 'run.completed'])
    expect(events[1]).toMatchObject({ stepId: 'r1:anchor:0', nodeId: 'anchor', activation: 0 })
  })
})
