import {
  completePipelineRun,
  completePipelineStep,
  deletePipeline,
  getPipeline,
  insertPipelineRun,
  insertPipelineStep,
  savePipeline,
  type PipelineRow
} from '../db'
import type { RunEvent } from './engine'
import type { Pipeline, PipelineGraph } from './types'
import { validate, type ValidationIssue } from './validate'

function fromRow(row: PipelineRow): Pipeline {
  const graph = JSON.parse(row.graph_json) as PipelineGraph
  return {
    id: row.id,
    name: row.name,
    scope: row.task_id ? { kind: 'task', taskId: row.task_id } : { kind: 'global' },
    nodes: graph.nodes,
    edges: graph.edges
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
  savePipeline({ id: p.id, task_id: taskIdOf(p), name: p.name, graph_json: JSON.stringify({ nodes: p.nodes, edges: p.edges }) })
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
    graph_json: JSON.stringify({ nodes: run.pipeline.nodes, edges: run.pipeline.edges })
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
