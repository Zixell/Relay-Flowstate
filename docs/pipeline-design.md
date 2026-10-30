# Agent pipelines — design

Goal: let the user automate what happens around a chat message with a BPMN-like
graph: blocks connected by arrows, conditions on arrows, parallel branches and
bounded loops. Example: agent writes code → independent review → commit on
pass, "fix the remarks" on fail, at most 3 rounds.

Status: phases 1–2 done (engine, wired to chat sessions, run card in the chat); no editor yet — code in `src/main/pipeline/`.

## Concepts

```
[pre-blocks] → [Anchor: Input prompt → Prompt handling] → [post-blocks ...]
```

- **Anchor** — exactly one per pipeline, cannot be deleted. It is the user's
  message (Input) plus the normal agent turn in the task's own session
  (Prompt handling), unaware of the pipeline.
- **Pre-blocks** — anything wired before the anchor. While they exist, a sent
  message is held: pre-blocks run first, the anchor runs when the chain reaches
  it. Pre-blocks can rewrite the prompt (`{{input}}`), e.g. add Jira context.
  Pre-blocks always run in a `new` session — the task's own session sees nothing
  before the user's message.
- **Post-blocks** — everything after the anchor.
- Every block chooses **session**: `current` (the task's chat session) or `new`
  (a fresh agent session in the same worktree, possibly another agent).

## Scope and precedence

- **Global pipeline** — at most one, no selection filters; applies to every task
  without its own pipeline. Facts like "code changed" are conditions on arrows
  inside the graph.
- **Task pipeline** — attached to one task; fully replaces the global one (no
  inheritance or merging).

## Execution semantics

Token-based, as in BPMN. A finished block emits tokens along its outgoing arrows.

### Outgoing arrows

| Arrows leaving a block | Behaviour |
|---|---|
| Unconditional | Always fire — several of them run **in parallel** |
| Conditional | Evaluated **in the order the user set** (number shown on the arrow); **first true wins** |
| Default (`else`) | Fires when no conditional arrow matched |

Unconditional and conditional arrows can be mixed: the unconditional ones fire
alongside the chosen conditional one. Same convention as BPMN's exclusive gateway,
n8n's Switch and Dify's IF/ELIF/ELSE. A per-block "all matching" mode (BPMN
inclusive gateway) can be added later if needed.

The validator rejects a block with conditional arrows and no default.

### Incoming arrows

- A regular block **runs on every arriving token** (BPMN uncontrolled merge).
  This is what makes loops work: the back-arrow and the forward arrow never
  arrive together.
- **Join** block waits for all incoming branches that can still arrive in this
  run: a missing arrow is waited for only while some queued or running block can
  still reach it (without passing the Join). So a Join after an if/else does not
  wait for the branch the condition cut off. After firing it starts collecting
  anew (a loop can bring it another round).
- The validator warns when a regular block receives arrows from parallel branches
  without a Join: it would run once per branch.

### Loops

- The start block is fixed, so back-arrows are well-defined (DFS from the start).
- Every back-arrow requires `maxIterations` — the editor highlights the cycle and
  refuses to save without it. Nested loops get independent counters.
- `onExhausted`: stop the run as failed (default) or jump to a chosen block
  (e.g. notify the user). That block must not lead back into the cycle, and
  cannot be a Join.
- A round of an outer loop restarts the counters of the loops inside it (loop
  bodies by natural-loop analysis; inner = strict subset). Every cycle has a
  back-arrow, so every run terminates.

### Conditions

- **Deterministic**: files changed (optionally a glob), shell exit code, iteration
  number, previous block status.
- **Structured output**: the block declares an output JSON schema; condition is an
  expression over it, e.g. `verdict == "pass"`.
- **LLM classifier**: a cheap model judges the output — last resort, unreliable.

### Failures

A block that fails (runner error or `status: error`) fires no plain and no
default arrow — only a conditional arrow that matches, e.g. `status == error`.
Without one the run fails and the other running branches are aborted.

### Data between blocks

Every block has an output (final text + parsed structured output). Prompts and
tool arguments are templates: `{{input}}`, `{{review.output}}`,
`{{review.json.issues}}`, `{{anchor.changedFiles}}`; `{{review}}` is short for
`{{review.output}}`. Lists of strings are written one per line, objects as JSON.
Shell commands are not templated — agent text never lands in a command line;
they will get values through environment variables.

### Guards

- Messages a pipeline sends to the current session never trigger a pipeline.
- Pre-blocks with `current` session are rejected by the validator.
- Two parallel blocks on the `current` session are rejected by the validator
  (one session cannot run two turns). Parallel `new`-session blocks that may edit
  files get a warning (shared worktree).
- A permission prompt inside a block pauses the run; task status → waiting.
- A user message during a run is queued; "Stop pipeline" cancels the run.
- Optional per-run budget (turns / cost), checked against account limits.

## Block types (v1)

| Type | What it does |
|---|---|
| Anchor | User message + normal turn in the current session |
| Agent step | Prompt template + agent + session (current/new) + allowed MCP servers + optional output schema |
| Static prompt | Sends a fixed/template message to the current session |
| Tool call | Calls an MCP tool directly with template arguments, no LLM |
| Action | Built-ins: git commit, shell command, notification |
| Join | Waits for parallel branches |

## Data model (sketch)

```ts
interface Pipeline {
  id: string
  name: string
  scope: { kind: 'global' } | { kind: 'task'; taskId: string }
  nodes: PipelineNode[]
  edges: PipelineEdge[]
}

interface PipelineEdge {
  id: string
  from: string
  to: string
  condition?: Condition
  order?: number          // among conditional arrows of one block
  isDefault?: boolean
  maxIterations?: number  // required on back-arrows
  onExhausted?: { kind: 'fail' } | { kind: 'goto'; nodeId: string }
}
```

Tables: `pipelines` (graph as JSON; unique index allows one global and one per
task), `pipeline_runs` (task, message, input, snapshot of the graph, status),
`pipeline_steps` (run, node, activation, status, output JSON). Run history
survives a restart; a run that was going when the app quit is marked
`interrupted` — it is not resumed.

## UI

- **Editor** — React Flow (xyflow). Palette of blocks, inspector panel for the
  selected block/arrow, live validation: cycles highlighted until a limit is set,
  missing defaults, unreachable blocks, parallel `current` sessions.
- **Task chat** — when a pipeline is attached, the chat shows a compact run card
  under the message: blocks with live statuses (pending / running / passed /
  failed / skipped), current iteration of loops. A held message shows "pre-pipeline
  running". Stop / open-in-editor buttons.
- **Run view** — the graph with the run's state painted on it; clicking a block
  opens its output (and the transcript of a `new` session). New-session blocks are
  visible only here, not as separate chats.
- **Global pipelines** — in Settings.

## Hooks into the existing code

- `turn.completed` from `SessionManager` (`src/main/session/manager.ts`) drives
  post-blocks; changed files / `commit_after` are already computed there.
- `sendMessage(taskId, …)` is already called from main (auto-resume) — the engine
  uses the same path, flagged as pipeline-originated.
- Pre-blocks intercept `sendMessage` before the anchor turn starts.
- New-session blocks reuse the agent adapters (`src/main/agents`) with a session
  that is not bound to the task's chat.

## Phases

- [x] 1. Engine without UI: model, validator, token executor, persistence; graphs
      defined in JSON; unit tests on semantics (parallel, first-match, loops, Join
      with dead paths)
- [x] 2. Agent step / Static prompt / Action blocks wired to SessionManager;
      new-session runner; recursion guard; run card in chat
- [ ] 3. Editor on React Flow with live validation; task and global pipelines
- [ ] 4. Run view with per-block output
- [ ] 5. Tool call block (direct MCP), structured output conditions, templates
- [ ] 6. Built-in templates: "Review → Commit / Fix", "Push ∥ Update docs"

## Code map (phase 1)

| File | What |
|---|---|
| `src/main/pipeline/types.ts` | Graph, blocks, arrows, conditions, step output |
| `src/main/pipeline/graph.ts` | Entry, reachability, back-arrows, loop bodies, pre-blocks, forks |
| `src/main/pipeline/validate.ts` | Errors and warnings for the editor |
| `src/main/pipeline/conditions.ts` | Condition evaluation, globs |
| `src/main/pipeline/template.ts` | `{{…}}` rendering |
| `src/main/pipeline/engine.ts` | `PipelineRun` — token executor over a `StepRunner` |
| `src/main/pipeline/store.ts` | Load/save pipelines, record runs (`src/main/db`) |

## Wiring (phase 2)

- `chat:send` and the first prompt of a new task go through `submitMessage`
  (`service.ts`): no pipeline → straight to the agent as before; otherwise the
  message is shown, a run starts and a `pipeline` card is put into the chat.
- Steps on the `current` session use `runTurn` (`session/manager.ts`): waits out
  a turn already going, sends, resolves on `turn.completed` with the turn's texts
  and changed files. Prompt blocks and current-session agent steps appear in the
  chat as `pipeline_prompt` messages ("Sent by the pipeline"); the anchor sends
  the rendered prompt but the chat shows what the user typed.
- `new`-session steps open their own adapter session in the worktree, run one
  turn, snapshot the worktree before/after for changed files, then dispose.
  Their permission prompts are shown in the task chat (they need an answer) and
  answered through the usual `chat:permission`; everything else stays in the run.
- A step with `outputSchema` is asked to end with a ```json block; without one
  the step fails. Any step's last ```json block (or an all-JSON answer) is parsed
  into `json`.
- Shell actions get earlier outputs as `PIPELINE_INPUT`,
  `PIPELINE_<BLOCK>_OUTPUT`, `_STATUS`, `_JSON`; a non-zero exit fails the step.
- A user message during a run is shown and queued; each queued message starts the
  next run. Stop in the chat (or on the card) cancels the run and the queue.
- While a run goes the task shows `running`; per-turn "finished" notifications are
  held back and one comes when the run ends.
- Tool call blocks fail with "not supported yet" until phase 5.

## Decisions

- One global pipeline at most, no filters; a task pipeline replaces it entirely.
- Pre-blocks run only in `new` sessions.
- Conditional arrows: first match in user order + mandatory default.
- Merge: any-arrival by default, explicit Join to wait for parallel branches.
- New-session output is visible only in the run view, not as separate chats.
