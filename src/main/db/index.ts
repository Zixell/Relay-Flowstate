import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import type { PipelineRunRow, PipelineStepRow } from '../pipeline/types'

let db: Database.Database | null = null

export function getDb(): Database.Database | null {
  return db
}

export function isDbReady(): boolean {
  return db !== null
}

export function initDatabase(): void {
  const dbPath = join(app.getPath('userData'), 'relay.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  createSchema(db)
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      process_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      branch TEXT,
      worktree_path TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      runtime_seconds INTEGER DEFAULT 0,
      changed_files_count INTEGER DEFAULT 0,
      notes TEXT,
      summary TEXT,
      metadata TEXT DEFAULT '{}',
      claude_session_id TEXT,
      agent_session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      content TEXT,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS terminal_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      timestamp INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS task_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      summary_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // Migrate existing databases — ignore errors if column already exists
  try { db.exec('ALTER TABLE tasks ADD COLUMN summary TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN worktree_path TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN claude_session_id TEXT') } catch { /* already exists */ }
  // agent_session_id replaces the Claude-specific column — it stores the resume
  // handle of whichever agent ran the task. Existing Claude ids are carried over.
  try { db.exec('ALTER TABLE tasks ADD COLUMN agent_session_id TEXT') } catch { /* already exists */ }
  try {
    db.exec(`UPDATE tasks SET agent_session_id = claude_session_id
             WHERE agent_session_id IS NULL AND claude_session_id IS NOT NULL`)
  } catch { /* claude_session_id may not exist on a fresh DB */ }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS task_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      summary_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`)
  } catch { /* already exists */ }

  // --- Chat mode ---
  // `transport` tells how the task talks to its agent: 'pty' (legacy terminal)
  // or 'chat' (structured adapter, see src/main/agents/adapter.ts).
  try { db.exec("ALTER TABLE tasks ADD COLUMN transport TEXT NOT NULL DEFAULT 'pty'") } catch { /* already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN model TEXT') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN mode TEXT') } catch { /* already exists */ }
  // The agent's latest plan (todo list), so it survives a restart.
  try { db.exec('ALTER TABLE tasks ADD COLUMN plan_json TEXT') } catch { /* already exists */ }
  // Starred tasks are pinned to the top of the sidebar.
  try { db.exec('ALTER TABLE tasks ADD COLUMN starred INTEGER NOT NULL DEFAULT 0') } catch { /* already exists */ }
  try { db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT') } catch { /* already exists or table not created yet */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      status TEXT NOT NULL,
      commit_before TEXT,
      commit_after TEXT,
      usage_json TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_turns_task ON turns(task_id, seq);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      attachments TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_tool ON messages(task_id, tool_call_id);
  `)
  // The agent's own marker for the end of a turn (message uuid, turn id) — where a fork continues from.
  try { db.exec('ALTER TABLE turns ADD COLUMN checkpoint TEXT') } catch { /* already exists */ }

  // --- Pipelines (docs/pipeline-design.md) ---
  // A pipeline with no task is the global one; the index allows one global and one per task.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipelines (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      graph_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_scope ON pipelines(COALESCE(task_id, ''));

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      pipeline_id TEXT,
      message_id TEXT,
      input TEXT NOT NULL,
      graph_json TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_task ON pipeline_runs(task_id, started_at);

    CREATE TABLE IF NOT EXISTS pipeline_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      activation INTEGER NOT NULL,
      status TEXT NOT NULL,
      output_json TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_steps_run ON pipeline_steps(run_id, started_at);
  `)
}

// --- Project queries ---
export function getAllProjects() {
  if (!db) return []
  return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all()
}

export function insertProject(project: {
  id: string
  name: string
  path: string
  description?: string
}) {
  if (!db) return
  db.prepare(
    'INSERT INTO projects (id, name, path, description) VALUES (@id, @name, @path, @description)'
  ).run(project)
}

export function upsertProject(project: {
  id: string
  name: string
  path: string
  description?: string
}): { id: string; name: string; path: string; description?: string } | undefined {
  if (!db) return undefined
  // If path already exists, return the existing record; otherwise insert
  db.prepare(
    'INSERT OR IGNORE INTO projects (id, name, path, description) VALUES (@id, @name, @path, @description)'
  ).run({ ...project, description: project.description ?? null })
  return db.prepare('SELECT * FROM projects WHERE path = ?').get(project.path) as ReturnType<typeof upsertProject>
}

// --- Task queries ---
/** What the dashboard shows for chat tasks instead of terminal output. */
const CHAT_PREVIEW_COLUMNS = `
  (SELECT m.content FROM messages m WHERE m.task_id = t.id AND m.role = 'assistant' AND m.kind = 'text' ORDER BY m.seq DESC LIMIT 1) AS last_message,
  (SELECT m.content FROM messages m WHERE m.task_id = t.id AND m.kind = 'permission' AND m.tool_status = 'pending' ORDER BY m.seq DESC LIMIT 1) AS pending_permission`

export function getAllTasks() {
  if (!db) return []
  return db
    .prepare(
      `SELECT t.*, p.name as project_name, p.path as project_path, ${CHAT_PREVIEW_COLUMNS}
       FROM tasks t
       JOIN projects p ON t.project_id = p.id
       ORDER BY t.updated_at DESC`
    )
    .all()
}

export function getTaskById(id: string) {
  if (!db) return null
  return db
    .prepare(
      `SELECT t.*, p.name as project_name, p.path as project_path, ${CHAT_PREVIEW_COLUMNS}
       FROM tasks t
       JOIN projects p ON t.project_id = p.id
       WHERE t.id = ?`
    )
    .get(id)
}

export function insertTask(task: {
  id: string
  project_id: string
  title: string
  prompt: string
  process_type: string
  branch?: string
  worktree_path?: string
  metadata?: string
  transport?: 'chat'
  model?: string
  mode?: string
}) {
  if (!db) return
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, prompt, process_type, branch, worktree_path, status, started_at, metadata, transport, model, mode)
     VALUES (@id, @project_id, @title, @prompt, @process_type, @branch, @worktree_path, 'running', unixepoch(), @metadata, @transport, @model, @mode)`
  ).run({
    ...task,
    branch: task.branch ?? null,
    worktree_path: task.worktree_path ?? null,
    metadata: task.metadata ?? '{}',
    transport: task.transport ?? 'chat',
    model: task.model ?? null,
    mode: task.mode ?? null
  })
}

export function updateTaskStatus(
  id: string,
  status: string,
  extra?: { runtime_seconds?: number; changed_files_count?: number }
) {
  if (!db) return
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `UPDATE tasks SET status = ?, updated_at = ?,
     runtime_seconds = COALESCE(?, runtime_seconds),
     changed_files_count = COALESCE(?, changed_files_count),
     completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END
     WHERE id = ?`
  ).run(
    status,
    now,
    extra?.runtime_seconds ?? null,
    extra?.changed_files_count ?? null,
    status,
    now,
    id
  )
}

/** Stores the agent's own session handle so the task can be resumed later. */
export function updateTaskAgentSessionId(id: string, agentSessionId: string) {
  if (!db) return
  db.prepare('UPDATE tasks SET agent_session_id = ?, updated_at = unixepoch() WHERE id = ?').run(agentSessionId, id)
}

/** Leaves updated_at alone: starring is not activity on the task. */
export function setTaskStarred(id: string, starred: boolean) {
  if (!db) return
  db.prepare('UPDATE tasks SET starred = ? WHERE id = ?').run(starred ? 1 : 0, id)
}

export function updateTaskTitle(id: string, title: string) {
  if (!db) return
  db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run(title, id)
}

export function updateTaskNotes(id: string, notes: string) {
  if (!db) return
  db.prepare('UPDATE tasks SET notes = ?, updated_at = unixepoch() WHERE id = ?').run(notes, id)
}

export function updateTaskSummary(id: string, summary: string) {
  if (!db) return
  db.prepare('UPDATE tasks SET summary = ?, updated_at = unixepoch() WHERE id = ?').run(summary, id)
}

/** Upsert the single summary for a task — there is always at most one row per task. */
export function appendTaskSummary(taskId: string, summaryJson: string) {
  if (!db) return
  db.prepare('DELETE FROM task_summaries WHERE task_id = ?').run(taskId)
  db.prepare('INSERT INTO task_summaries (task_id, summary_json) VALUES (?, ?)').run(taskId, summaryJson)
  db.prepare('UPDATE tasks SET summary = ?, updated_at = unixepoch() WHERE id = ?').run(summaryJson, taskId)
}

/** Return all summaries for a task ordered oldest → newest. */
export function getTaskSummaries(taskId: string): Array<{ id: number; task_id: string; summary_json: string; created_at: number }> {
  if (!db) return []
  return db.prepare('SELECT * FROM task_summaries WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as Array<{ id: number; task_id: string; summary_json: string; created_at: number }>
}

// --- Settings ---
export function getDbSetting(key: string): string | null {
  if (!db) return null
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setDbSetting(key: string, value: string): void {
  if (!db) return
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function getAllSettings(): Record<string, string> {
  if (!db) return {}
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

export function deleteTask(id: string) {
  if (!db) return
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
}

export function deleteProject(id: string) {
  if (!db) return
  // CASCADE in schema handles tasks + their related rows
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
}

/** On app start: move any tasks left in 'running' state to 'paused' (they can't be running if the app just started). */
export function resetRunningTasks(): void {
  if (!db) return
  db.prepare(`UPDATE tasks SET status = 'paused', updated_at = unixepoch() WHERE status = 'running'`).run()
}

/**
 * Turns tasks from the terminal era into chat tasks. Their transcript is read
 * from the agent's own session the first time the chat is opened
 * (`legacyHistory` in metadata), so startup stays fast.
 */
export function convertLegacyTasks(): number {
  if (!db) return 0
  const rows = db.prepare(`SELECT id, metadata FROM tasks WHERE transport = 'pty'`).all() as { id: string; metadata: string | null }[]
  const update = db.prepare(`UPDATE tasks SET transport = 'chat', metadata = ? WHERE id = ?`)
  for (const row of rows) {
    let meta: Record<string, unknown> = {}
    try {
      meta = row.metadata ? JSON.parse(row.metadata) : {}
    } catch {
      // keep going with a fresh object
    }
    update.run(JSON.stringify({ ...meta, legacyHistory: true }), row.id)
  }
  return rows.length
}

/** Moves a task to another agent: the old agent's session, model and mode no longer apply. */
export function switchTaskAgent(id: string, processType: string, metadata: Record<string, unknown>): void {
  if (!db) return
  db.prepare(
    'UPDATE tasks SET process_type = ?, agent_session_id = NULL, model = NULL, mode = NULL, metadata = ?, updated_at = unixepoch() WHERE id = ?'
  ).run(processType, JSON.stringify(metadata), id)
}

export function updateTaskMetadata(id: string, metadata: Record<string, unknown>): void {
  if (!db) return
  db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), id)
}

// --- Event queries ---
export function getTaskEvents(taskId: string) {
  if (!db) return []
  return db
    .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY timestamp ASC')
    .all(taskId)
}

export function insertTaskEvent(event: {
  id: string
  task_id: string
  type: string
  content?: string
  metadata?: string
}) {
  if (!db) return
  db.prepare(
    'INSERT INTO task_events (id, task_id, type, content, metadata) VALUES (@id, @task_id, @type, @content, @metadata)'
  ).run({ ...event, content: event.content ?? null, metadata: event.metadata ?? null })
}

// --- Chat: turns ---
export interface TurnRow {
  id: string
  task_id: string
  seq: number
  status: 'running' | 'completed' | 'interrupted' | 'failed'
  commit_before: string | null
  commit_after: string | null
  usage_json: string | null
  checkpoint: string | null
  started_at: number
  completed_at: number | null
}

export function insertTurn(turn: { id: string; task_id: string; commit_before?: string }): TurnRow | undefined {
  if (!db) return undefined
  const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM turns WHERE task_id = ?').get(turn.task_id) as { n: number }).n
  db.prepare(
    `INSERT INTO turns (id, task_id, seq, status, commit_before, started_at)
     VALUES (?, ?, ?, 'running', ?, unixepoch())`
  ).run(turn.id, turn.task_id, seq, turn.commit_before ?? null)
  return db.prepare('SELECT * FROM turns WHERE id = ?').get(turn.id) as TurnRow
}

export function completeTurn(
  id: string,
  fields: { status: TurnRow['status']; commit_after?: string; usage_json?: string; checkpoint?: string }
): void {
  if (!db) return
  db.prepare(
    `UPDATE turns SET status = ?, commit_after = COALESCE(?, commit_after),
     usage_json = COALESCE(?, usage_json), checkpoint = COALESCE(?, checkpoint), completed_at = unixepoch() WHERE id = ?`
  ).run(fields.status, fields.commit_after ?? null, fields.usage_json ?? null, fields.checkpoint ?? null, id)
}

export function getTurns(taskId: string): TurnRow[] {
  if (!db) return []
  return db.prepare('SELECT * FROM turns WHERE task_id = ? ORDER BY seq ASC').all(taskId) as TurnRow[]
}

export function getTurn(id: string): TurnRow | undefined {
  if (!db) return undefined
  return db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | undefined
}

/** Total seconds spent in turns — the chat-mode runtime of a task. */
export function getTurnsRuntimeSeconds(taskId: string): number {
  if (!db) return 0
  const row = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(completed_at, unixepoch()) - started_at), 0) AS s FROM turns WHERE task_id = ?`
  ).get(taskId) as { s: number }
  return row.s
}

/** The task's agent process is gone: tool calls it left running (subagents) cannot finish anymore. */
export function failRunningTools(taskId: string): void {
  if (!db) return
  db.prepare(`UPDATE messages SET tool_status = 'error' WHERE task_id = ? AND kind = 'tool_call' AND tool_status = 'running'`).run(taskId)
}

/** On app start, turns cannot still be in flight. */
export function resetRunningTurns(): void {
  if (!db) return
  db.prepare(`UPDATE turns SET status = 'interrupted', completed_at = unixepoch() WHERE status = 'running'`).run()
  // The agent process that asked is gone, so nobody can answer these anymore.
  db.prepare(`UPDATE messages SET tool_status = 'expired' WHERE kind = 'permission' AND tool_status = 'pending'`).run()
  db.prepare(`UPDATE messages SET tool_status = 'error' WHERE kind = 'tool_call' AND tool_status = 'running'`).run()
  // No chat agent survives a restart, so none can still be working or waiting for an answer.
  db.prepare(`UPDATE tasks SET status = 'paused' WHERE transport = 'chat' AND status IN ('running', 'waiting')`).run()
}

// --- Chat: messages ---
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system'
/** `pipeline` is a pipeline run's card (content `{ runId }`); `pipeline_prompt` a message a pipeline sent to the session. */
export type MessageKind = 'text' | 'thinking' | 'tool_call' | 'permission' | 'plan' | 'error' | 'handoff' | 'pipeline' | 'pipeline_prompt'

export interface MessageRow {
  id: string
  task_id: string
  turn_id: string | null
  seq: number
  role: MessageRole
  kind: MessageKind
  /** Text, or JSON for structured kinds (tool_call, permission, plan). */
  content: string | null
  tool_call_id: string | null
  tool_status: string | null
  /** JSON array of `MessageAttachment`. */
  attachments: string | null
  created_at: number
  updated_at: number
}

export interface MessageAttachment {
  id: string
  mediaType: string
}

export function insertMessage(msg: {
  id: string
  task_id: string
  turn_id?: string | null
  role: MessageRole
  kind: MessageKind
  content?: string | null
  tool_call_id?: string | null
  tool_status?: string | null
  attachments?: MessageAttachment[]
}): MessageRow | undefined {
  if (!db) return undefined
  const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE task_id = ?').get(msg.task_id) as { n: number }).n
  const now = Date.now()
  db.prepare(
    `INSERT INTO messages (id, task_id, turn_id, seq, role, kind, content, tool_call_id, tool_status, attachments, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    msg.id, msg.task_id, msg.turn_id ?? null, seq, msg.role, msg.kind,
    msg.content ?? null, msg.tool_call_id ?? null, msg.tool_status ?? null,
    msg.attachments?.length ? JSON.stringify(msg.attachments) : null, now, now
  )
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id) as MessageRow
}

export function updateMessage(id: string, fields: { content?: string; tool_status?: string }): MessageRow | undefined {
  if (!db) return undefined
  db.prepare(
    `UPDATE messages SET content = COALESCE(?, content), tool_status = COALESCE(?, tool_status), updated_at = ? WHERE id = ?`
  ).run(fields.content ?? null, fields.tool_status ?? null, Date.now(), id)
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
}

export function getMessage(id: string): MessageRow | undefined {
  if (!db) return undefined
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
}

export function getMessageByToolCall(taskId: string, toolCallId: string): MessageRow | undefined {
  if (!db) return undefined
  return db
    .prepare(`SELECT * FROM messages WHERE task_id = ? AND tool_call_id = ? AND kind = 'tool_call'`)
    .get(taskId, toolCallId) as MessageRow | undefined
}

/** A page of history, newest last. `beforeSeq` pages backwards. */
export function getMessages(taskId: string, opts: { beforeSeq?: number; limit?: number } = {}): MessageRow[] {
  if (!db) return []
  const limit = opts.limit ?? 500
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`
    )
    .all(taskId, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, limit) as MessageRow[]
  return rows.reverse()
}

/** Agent session ids tied to tasks, and the external sessions tasks were imported from. */
export function getTaskSessionLinks(): { id: string; agent_session_id: string | null; metadata: string | null }[] {
  if (!db) return []
  return db.prepare('SELECT id, agent_session_id, metadata FROM tasks').all() as {
    id: string
    agent_session_id: string | null
    metadata: string | null
  }[]
}

export function updateTaskPlan(id: string, plan: unknown[]): void {
  if (!db) return
  db.prepare('UPDATE tasks SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), id)
}

export function updateTaskChatSettings(id: string, fields: { model?: string; mode?: string }): void {
  if (!db) return
  db.prepare(
    'UPDATE tasks SET model = COALESCE(?, model), mode = COALESCE(?, mode), updated_at = unixepoch() WHERE id = ?'
  ).run(fields.model ?? null, fields.mode ?? null, id)
}

// --- Pipelines ---
export type { PipelineRunRow, PipelineStepRow }

export interface PipelineRow {
  id: string
  /** Null for the global pipeline. */
  task_id: string | null
  name: string
  graph_json: string
  created_at: number
  updated_at: number
}

export function getPipeline(taskId: string | null): PipelineRow | undefined {
  if (!db) return undefined
  return db.prepare('SELECT * FROM pipelines WHERE task_id IS ?').get(taskId) as PipelineRow | undefined
}

/** Replaces the pipeline of the same scope. */
export function savePipeline(row: { id: string; task_id: string | null; name: string; graph_json: string }): void {
  if (!db) return
  db.prepare(
    `INSERT INTO pipelines (id, task_id, name, graph_json) VALUES (@id, @task_id, @name, @graph_json)
     ON CONFLICT(COALESCE(task_id, '')) DO UPDATE SET id = excluded.id, name = excluded.name,
       graph_json = excluded.graph_json, updated_at = unixepoch()`
  ).run(row)
}

export function deletePipeline(taskId: string | null): void {
  if (!db) return
  db.prepare('DELETE FROM pipelines WHERE task_id IS ?').run(taskId)
}

export function insertPipelineRun(run: {
  id: string
  task_id: string
  pipeline_id: string | null
  message_id: string | null
  input: string
  graph_json: string
}): void {
  if (!db) return
  db.prepare(
    `INSERT INTO pipeline_runs (id, task_id, pipeline_id, message_id, input, graph_json, status, started_at)
     VALUES (@id, @task_id, @pipeline_id, @message_id, @input, @graph_json, 'running', unixepoch())`
  ).run(run)
}

export function completePipelineRun(id: string, status: PipelineRunRow['status'], error?: string): void {
  if (!db) return
  db.prepare('UPDATE pipeline_runs SET status = ?, error = ?, completed_at = unixepoch() WHERE id = ?').run(status, error ?? null, id)
  // Steps the run stopped before they finished
  db.prepare(`UPDATE pipeline_steps SET status = 'cancelled', completed_at = unixepoch() WHERE run_id = ? AND status = 'running'`).run(id)
}

export function insertPipelineStep(step: { id: string; run_id: string; node_id: string; activation: number }): void {
  if (!db) return
  db.prepare(
    `INSERT INTO pipeline_steps (id, run_id, node_id, activation, status, started_at)
     VALUES (@id, @run_id, @node_id, @activation, 'running', unixepoch())`
  ).run(step)
}

export function completePipelineStep(id: string, status: 'ok' | 'error', outputJson: string): void {
  if (!db) return
  db.prepare('UPDATE pipeline_steps SET status = ?, output_json = ?, completed_at = unixepoch() WHERE id = ?').run(status, outputJson, id)
}

export function getPipelineRuns(taskId: string, limit = 50): PipelineRunRow[] {
  if (!db) return []
  return db
    .prepare('SELECT * FROM pipeline_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?')
    .all(taskId, limit) as PipelineRunRow[]
}

export function getPipelineRun(id: string): PipelineRunRow | undefined {
  if (!db) return undefined
  return db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(id) as PipelineRunRow | undefined
}

export function getPipelineSteps(runId: string): PipelineStepRow[] {
  if (!db) return []
  return db.prepare('SELECT * FROM pipeline_steps WHERE run_id = ? ORDER BY started_at, rowid').all(runId) as PipelineStepRow[]
}

/** On app start no run can still be going: the sessions its steps ran in are gone. */
export function resetRunningPipelineRuns(): void {
  if (!db) return
  db.prepare(`UPDATE pipeline_steps SET status = 'cancelled', completed_at = unixepoch() WHERE status = 'running'`).run()
  db.prepare(`UPDATE pipeline_runs SET status = 'interrupted', completed_at = unixepoch() WHERE status = 'running'`).run()
}
