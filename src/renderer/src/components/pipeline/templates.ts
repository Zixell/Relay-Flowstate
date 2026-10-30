import type { PipelineGraph } from '../../../../main/pipeline/types'
import { VERDICT_SCHEMA } from './model'

export interface PipelineTemplate {
  id: string
  name: string
  description: string
  graph: PipelineGraph
}

const at = (x: number, y: number): { x: number; y: number } => ({ x: x * 300, y: y * 150 })

/** Ready-made pipelines to start from; each is a valid graph (see templates.test.ts). */
export const TEMPLATES: PipelineTemplate[] = [
  {
    id: 'review-loop',
    name: 'Review → Commit / Fix',
    description: 'An independent agent reviews every change. Passed — commit; failed — the chat agent fixes the remarks, up to 3 rounds.',
    graph: {
      budget: { maxTurns: 10 },
      nodes: [
        { id: 'anchor', type: 'anchor', position: at(0, 0) },
        {
          id: 'review',
          label: 'Review',
          type: 'agent',
          session: 'new',
          prompt:
            'Review the uncommitted changes in this repository (git diff, or the files changed recently). Check correctness, edge cases and obvious bugs; ignore style nits.\n\nThe task was: {{input}}\n\nIf there are no changes, the verdict is pass.',
          outputSchema: VERDICT_SCHEMA,
          position: at(1, 0)
        },
        { id: 'commit', label: 'Commit', type: 'action', action: 'commit', message: '{{input}}', position: at(2, -0.6) },
        { id: 'fix', label: 'Fix the remarks', type: 'prompt', prompt: 'A reviewer found problems in your changes. Fix them:\n\n{{review.json.issues}}', position: at(2, 0.6) },
        { id: 'stuck', label: 'Notify', type: 'action', action: 'notify', message: 'Review still fails after 3 rounds', position: at(3, 0.6) }
      ],
      edges: [
        { id: 'anchor-review', from: 'anchor', to: 'review' },
        { id: 'review-commit', from: 'review', to: 'commit', condition: { kind: 'output', path: 'json.verdict', op: 'eq', value: 'pass' }, order: 1 },
        { id: 'review-fix', from: 'review', to: 'fix', isDefault: true },
        { id: 'fix-review', from: 'fix', to: 'review', maxIterations: 3, onExhausted: { kind: 'goto', nodeId: 'stuck' } }
      ]
    }
  },
  {
    id: 'ship',
    name: 'Commit → Push & Update docs',
    description: 'Commits what the agent did, then pushes and updates the docs in parallel, and tells you when both are done.',
    graph: {
      budget: { maxTurns: 4 },
      nodes: [
        { id: 'anchor', type: 'anchor', position: at(0, 0) },
        { id: 'commit', label: 'Commit', type: 'action', action: 'commit', message: '{{input}}', position: at(1, 0) },
        { id: 'push', label: 'Push', type: 'action', action: 'shell', command: 'git push', position: at(2, -0.6) },
        {
          id: 'docs',
          label: 'Update docs',
          type: 'agent',
          session: 'new',
          prompt: 'The last commit changed this project. Update the documentation (README, docs/) where it no longer matches the code. Change nothing else.',
          position: at(2, 0.6)
        },
        { id: 'both', type: 'join', position: at(3, 0) },
        { id: 'done', label: 'Notify', type: 'action', action: 'notify', message: 'Pushed, docs updated', position: at(4, 0) }
      ],
      edges: [
        { id: 'anchor-commit', from: 'anchor', to: 'commit' },
        { id: 'commit-push', from: 'commit', to: 'push' },
        { id: 'commit-docs', from: 'commit', to: 'docs' },
        { id: 'push-both', from: 'push', to: 'both' },
        { id: 'docs-both', from: 'docs', to: 'both' },
        { id: 'both-done', from: 'both', to: 'done' }
      ]
    }
  },
  {
    id: 'tests-gate',
    name: 'Tests gate',
    description: 'Runs the tests after every change. When they fail, the chat agent gets the output and fixes it, up to 3 rounds.',
    graph: {
      budget: { maxTurns: 6 },
      nodes: [
        { id: 'anchor', type: 'anchor', position: at(0, 0) },
        { id: 'test', label: 'Run tests', type: 'action', action: 'shell', command: 'npm test', position: at(1, 0) },
        { id: 'fix', label: 'Fix the tests', type: 'prompt', prompt: 'The tests fail after your change. Fix the code (not the tests, unless they are wrong):\n\n{{test.output}}', position: at(2, 0.6) },
        { id: 'green', label: 'Notify', type: 'action', action: 'notify', message: 'Tests pass', position: at(2, -0.6) }
      ],
      edges: [
        { id: 'anchor-test', from: 'anchor', to: 'test' },
        { id: 'test-fix', from: 'test', to: 'fix', condition: { kind: 'status', equals: 'error' }, order: 1 },
        { id: 'test-green', from: 'test', to: 'green', isDefault: true },
        { id: 'fix-test', from: 'fix', to: 'test', maxIterations: 3 }
      ]
    }
  },
  {
    id: 'refine',
    name: 'Refine the prompt first',
    description: 'Before the chat agent sees your message, another agent turns it into a precise task with acceptance criteria.',
    graph: {
      budget: { maxTurns: 3 },
      nodes: [
        {
          id: 'refine',
          label: 'Refine the request',
          type: 'agent',
          session: 'new',
          prompt:
            'Rewrite this request into a precise task for a coding agent working in this repository: what to change, where, and how to tell it is done. Look at the code if it helps. Answer with the task only.\n\nRequest: {{input}}',
          position: at(0, 0)
        },
        { id: 'anchor', type: 'anchor', prompt: '{{input}}\n\nRefined task:\n{{refine.output}}', position: at(1, 0) }
      ],
      edges: [{ id: 'refine-anchor', from: 'refine', to: 'anchor' }]
    }
  }
]
