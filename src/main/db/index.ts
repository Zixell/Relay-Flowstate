import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'

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
  createSchema()
}

function createSchema(): void {
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
  ).run(project)
  return db.prepare('SELECT * FROM projects WHERE path = ?').get(project.path) as ReturnType<typeof upsertProject>
}

// --- Task queries ---
export function getAllTasks() {
  if (!db) return []
  return db
    .prepare(
      `SELECT t.*, p.name as project_name, p.path as project_path
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
      `SELECT t.*, p.name as project_name, p.path as project_path
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
}) {
  if (!db) return
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, prompt, process_type, branch, worktree_path, status, started_at, metadata)
     VALUES (@id, @project_id, @title, @prompt, @process_type, @branch, @worktree_path, 'running', unixepoch(), @metadata)`
  ).run({
    ...task,
    branch: task.branch ?? null,
    worktree_path: task.worktree_path ?? null,
    metadata: task.metadata ?? '{}'
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

/** Return IDs of all tasks currently in completed or waiting state (used to pre-populate status locks). */
export function getLockedTaskIds(): string[] {
  if (!db) return []
  const rows = db.prepare(`SELECT id FROM tasks WHERE status IN ('completed', 'waiting', 'paused', 'failed')`).all() as Array<{ id: string }>
  return rows.map((r) => r.id)
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

// --- Terminal logs ---
export function getTerminalLogs(taskId: string) {
  if (!db) return []
  return db
    .prepare('SELECT * FROM terminal_logs WHERE task_id = ? ORDER BY id ASC')
    .all(taskId)
}

export function insertTerminalLog(taskId: string, data: string) {
  if (!db) return
  db.prepare('INSERT INTO terminal_logs (task_id, data) VALUES (?, ?)').run(taskId, data)
}

