import {
  completePipelineRun,
  completePipelineStep,
  deletePipeline,
  getPipeline,
  getPipelineRun,
  getPipelineStep,
  getTaskById,
  insertPipelineRun,
  insertPipelineStep,
  savePipeline,
  type PipelineRow
} from '../db'
import type { RunEvent } from './engine'
import { getAgent } from '../agents'
import type { Pipeline, PipelineGraph, StepOutput, TranscriptItem } from './types'
import { validate, type ValidationIssue } from './validate'

function fromRow(row: PipelineRow): Pipeline {
  const graph = JSON.parse(row.graph_json) as PipelineGraph
  return {
    id: row.id,
    name: row.name,
    scope: row.task_id ? { kind: 'task', taskId: row.task_id } : { kind: 'global' },
    nodes: graph.nodes,
    edges: graph.edges,
    budget: graph.budget
  }
}

const taskIdOf = (p: Pick<Pipeline, 'scope'>): string | null => (p.scope.kind === 'task' ? p.scope.taskId : null)

/** The task's own pipeline, else the global one. */
export function pipelineForTask(taskId: string): Pipeline | undefined {
  const row = getPipeline(taskId) ?? getPipeline(null)
  return row && fromRow(row)
}

export function loadPipeline(taskId: string | null): Pipeline | undefined {
  const row = getPipeline(taskId)
  return row && fromRow(row)
}

/** Saves only a valid graph; returns what is wrong otherwise. */
export function storePipeline(p: Pipeline): ValidationIssue[] {
  const { ok, issues } = validate(p)
  if (!ok) return issues
  savePipeline({ id: p.id, task_id: taskIdOf(p), name: p.name, graph_json: JSON.stringify({ nodes: p.nodes, edges: p.edges, budget: p.budget }) })
  return issues
}

export function removePipeline(taskId: string | null): void {
  deletePipeline(taskId)
}

/** Starts the run's record; feed the run's events to the returned function. */
export function recordRun(run: {
  id: string
  taskId: string
  pipeline: Pipeline
  messageId: string | null
  input: string
}): (event: RunEvent) => void {
  insertPipelineRun({
    id: run.id,
    task_id: run.taskId,
    pipeline_id: run.pipeline.id,
    message_id: run.messageId,
    input: run.input,
    graph_json: JSON.stringify({ name: run.pipeline.name, nodes: run.pipeline.nodes, edges: run.pipeline.edges, budget: run.pipeline.budget })
  })
  return (event) => {
    switch (event.type) {
      case 'step.started':
        return insertPipelineStep({ id: event.stepId, run_id: event.runId, node_id: event.nodeId, activation: event.activation })
      case 'step.completed':
        return completePipelineStep(event.stepId, event.output.status, JSON.stringify(event.output))
      case 'run.completed':
        return completePipelineRun(event.runId, event.status, event.error)
    }
  }
}

/** What a step that ran in its own session said and did, read back from the agent's history. */
export async function stepTranscript(stepId: string): Promise<TranscriptItem[]> {
  const step = getPipelineStep(stepId)
  if (!step?.output_json) return []
  const output = JSON.parse(step.output_json) as StepOutput
  const run = getPipelineRun(step.run_id)
  const task = run ? (getTaskById(run.task_id) as { process_type: string; worktree_path?: string | null; project_path: string } | null) : null
  if (!output.sessionId || !run || !task) return []
  const graph = JSON.parse(run.graph_json) as PipelineGraph
  const node = graph.nodes.find((n) => n.id === step.node_id)
  const agentId = node?.type === 'agent' && node.agent ? node.agent : task.process_type
  const history = getAgent(agentId).chat?.history
  if (!history) return []
  const entries = await history.load(output.sessionId, task.worktree_path || task.project_path)
  const items: TranscriptItem[] = []
  const tools = new Map<string, TranscriptItem>()
  for (const entry of entries) {
    if (entry.type === 'user') {
      items.push({ kind: 'user', text: entry.text })
      continue
    }
    const e = entry.event
    if (e.type === 'message.completed' && e.text.trim()) items.push({ kind: 'assistant', text: e.text })
    else if (e.type === 'tool.started') {
      const item: TranscriptItem = { kind: 'tool', text: `${e.name}: ${e.title}`, status: 'running' }
      tools.set(e.toolCallId, item)
      items.push(item)
    } else if (e.type === 'tool.completed') {
      const item = tools.get(e.toolCallId)
      if (item) item.status = e.status
    }
  }
  return items
}
