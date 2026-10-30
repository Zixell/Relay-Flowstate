/**
 * Agent pipelines: a BPMN-like graph of blocks run around a chat message.
 * Design and semantics: docs/pipeline-design.md.
 */

/** `current` is the task's own chat session; `new` is a fresh agent session in the same worktree. */
export type SessionTarget = 'current' | 'new'

interface NodeBase {
  /** Stable and readable — templates refer to a block's output by it: `{{review.output}}`. */
  id: string
  label?: string
  /** Position in the editor. */
  position?: { x: number; y: number }
}

/** The user's message and the normal turn in the task's session. Exactly one per pipeline. */
export interface AnchorNode extends NodeBase {
  type: 'anchor'
  /** What is sent to the session; `{{input}}` by default, pre-blocks can enrich it. */
  prompt?: string
}

/** An agent turn with its own prompt. */
export interface AgentNode extends NodeBase {
  type: 'agent'
  prompt: string
  session: SessionTarget
  /** Agent id from the registry; defaults to the task's agent. */
  agent?: string
  /** MCP servers the step may use; all configured ones when absent. */
  mcpServers?: string[]
  /** JSON schema the final answer must match; parsed into the step's `json`. */
  outputSchema?: Record<string, unknown>
}

/** A fixed message sent to the task's session. */
export interface PromptNode extends NodeBase {
  type: 'prompt'
  prompt: string
}

/** A direct MCP tool call, no LLM involved. */
export interface ToolNode extends NodeBase {
  type: 'tool'
  server: string
  tool: string
  /** Values may contain templates. */
  args: Record<string, unknown>
}

export type ActionNode = NodeBase & { type: 'action' } & (
    | { action: 'commit'; message?: string }
    | { action: 'shell'; command: string }
    | { action: 'notify'; message: string }
  )

/** Waits for the parallel branches that can still reach it. */
export interface JoinNode extends NodeBase {
  type: 'join'
}

export type PipelineNode = AnchorNode | AgentNode | PromptNode | ToolNode | ActionNode | JoinNode

export type CompareOp = 'eq' | 'neq' | 'contains' | 'matches' | 'gt' | 'lt' | 'exists'

/** Evaluated against the output of the block the arrow leaves. */
export type Condition =
  | { kind: 'status'; equals: StepStatus }
  /** The block changed files; with `glob`, at least one changed file matches it. */
  | { kind: 'filesChanged'; glob?: string }
  /** `path` into the step output: `json.verdict`, `exitCode`, `output`. */
  | { kind: 'output'; path: string; op: CompareOp; value?: unknown }
  | { kind: 'all'; of: Condition[] }
  | { kind: 'any'; of: Condition[] }
  | { kind: 'not'; of: Condition }

export interface PipelineEdge {
  id: string
  from: string
  to: string
  condition?: Condition
  /** Evaluation order among the conditional arrows of one block; lower first. */
  order?: number
  /** Fires when no conditional arrow of the block matched. */
  isDefault?: boolean
  /** Required on an arrow that closes a loop. */
  maxIterations?: number
  /** What happens when the loop wants another round past `maxIterations`. */
  onExhausted?: { kind: 'fail' } | { kind: 'goto'; nodeId: string }
}

export type PipelineScope = { kind: 'global' } | { kind: 'task'; taskId: string }

export interface PipelineGraph {
  nodes: PipelineNode[]
  edges: PipelineEdge[]
}

export interface Pipeline extends PipelineGraph {
  id: string
  name: string
  scope: PipelineScope
}

export type StepStatus = 'ok' | 'error'

export interface StepOutput {
  status: StepStatus
  /** The final text: the agent's answer, the tool result, the command output. */
  output: string
  /** Structured output, when the block declared a schema or the tool returned JSON. */
  json?: unknown
  exitCode?: number
  /** Files the step changed in the worktree (relative paths). */
  changedFiles?: string[]
  /** Agent session the step ran in — to open its transcript. */
  sessionId?: string
  /** What went wrong, for an `error` step. */
  error?: string
}

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export type RunEvent =
  | { type: 'run.started'; runId: string }
  | { type: 'step.started'; runId: string; stepId: string; nodeId: string; activation: number }
  | { type: 'step.completed'; runId: string; stepId: string; nodeId: string; output: StepOutput }
  | { type: 'loop.exhausted'; runId: string; edgeId: string }
  | { type: 'run.completed'; runId: string; status: RunStatus; error?: string }

export interface ValidationIssue {
  /** An error blocks saving; a warning is shown but allowed. */
  level: 'error' | 'warning'
  code:
    | 'anchor-count'
    | 'duplicate-id'
    | 'dangling-edge'
    | 'multiple-entries'
    | 'unreachable'
    | 'loop-limit'
    | 'exhausted-target'
    | 'missing-default'
    | 'multiple-defaults'
    | 'default-without-conditions'
    | 'condition-and-default'
    | 'pre-current-session'
    | 'parallel-current-session'
    | 'parallel-merge'
    | 'join-inputs'
    | 'node-config'
  message: string
  nodeIds?: string[]
  edgeIds?: string[]
}

export interface PipelineRunRow {
  id: string
  task_id: string
  pipeline_id: string | null
  message_id: string | null
  input: string
  /** The graph (with the pipeline's `name`) as it was when the run started — the pipeline may have been edited since. */
  graph_json: string
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  error: string | null
  started_at: number
  completed_at: number | null
}

export interface PipelineStepRow {
  id: string
  run_id: string
  node_id: string
  activation: number
  status: 'running' | 'ok' | 'error' | 'cancelled'
  /** JSON of the step's `StepOutput`. */
  output_json: string | null
  started_at: number
  completed_at: number | null
}
