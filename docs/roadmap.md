# Relay Flowstate — roadmap

Goal: an autonomous workplace for coding agents. A task goes from a ticket to a
merged change without opening the agent's own app, an IDE, a terminal or the
browser. Compared against Conductor, Claude Code (desktop/web), Codex, Cursor,
Vibe Kanban and Devin.

What already holds: task → isolated worktree → chat with Claude / Codex / ACP
agents → merge; statuses and dashboard, files changed, timeline, recap, fork,
switching agents mid-task, usage limits and auto-continue, floating chat,
session import, pipelines around messages (docs/pipeline-design.md).

Order of work: **1 → 3 → 2 → 4**, then **6**. Items 1 and 3 remove the IDE and
the terminal; 2 and 4 close the ticket → code → review → MR → CI → ticket loop;
6 makes it run on its own on top of the pipeline engine.

## Tier 1 — what makes people leave the app every day

### 1. Diff review with comments to the agent
- [ ] Review view of a task's changes like a merge request: per file, per hunk
- [ ] Comment on a line or a selection; "Send remarks to the agent" as one message
- [ ] Quick manual edit of a file (Monaco), "Open in editor" for the rest
- [ ] Accept / revert per file or hunk (turn snapshots already exist)

### 2. Merge request / pull request and CI loop
- [ ] Create an MR (GitLab) or PR (GitHub) from a task: title and description from the recap
- [ ] CI status on the task card and in the chat; logs of a failed job
- [ ] "CI failed — fix it": the failed job's log goes to the agent
- [ ] Review comments of the MR shown in the task; "Address the comments" sends them to the agent
- [ ] Merge from the app when CI is green

### 3. Run and preview
- [ ] Per-project scripts: `setup` when a worktree is created (install, .env), `run` for the dev server
- [ ] A port per worktree, so several tasks run side by side
- [ ] Built-in browser preview of the running app
- [ ] Pick an element or take a screenshot in the preview → attached to the next message
- [ ] Dev server output in the console tab; "Send the error to the agent"

### 4. Tasks from the tracker
- [ ] Create a task from a Jira issue: summary, description, linked Confluence pages, branch named by the key
- [ ] Move the issue through its workflow when the task is merged / MR opened
- [ ] Board view of tasks: columns by status (Vibe Kanban style), drag to change

### 5. Agent configuration in the app
- [ ] Editor for `CLAUDE.md` / `AGENTS.md` of the project
- [ ] MCP servers: list, add, test, enable per project (today Relay only reads `~/.claude.json` and `.mcp.json`)
- [ ] Permission rules (allow / deny) per project
- [ ] Skills and slash commands: list, create, edit

## Tier 2 — from a good client to an autonomous system

### 6. Pipeline triggers beyond chat messages
- [ ] Trigger blocks: new Jira issue (JQL), CI failed, new MR comment, schedule (cron), manual button
- [ ] A triggered run creates its task and worktree by itself; the result waits for review
- [ ] Inbox of finished autonomous runs to review and merge

### 7. Orchestrating several agents
- [ ] Best-of-N: one task on several agents (Claude, Codex) in separate worktrees, compare, merge the best
- [ ] Decomposition: a planner splits a task into subtasks that run in parallel and merge back
- [ ] Parent / child tasks in the sidebar

### 8. Remote control
- [ ] Approve permissions, answer questions and see status from a phone
- [ ] Notifications and replies through Telegram / Slack
- [ ] Waiting-for-you queue across tasks

### 9. Project memory
- [ ] Project notes and decisions shared by every task, added to the agent's context
- [ ] Search across past tasks, chats and recaps ("how did we solve X")

## Tier 3 — polish

### 10. Analytics
- [ ] Cost and limits by task, project and agent over time
- [ ] Time to merge, share of runs that passed review, pipeline step stats

### 11. Onboarding
- [ ] Install an agent's CLI from the app, not only sign in
- [ ] First-run wizard: agents, first project, a pipeline template
- [ ] `git init` offer for a project without git

### 12. Safety of autonomy
- [ ] Sandbox for commands of autonomous runs
- [ ] Hard spending caps per project and per day, on top of per-run budgets
- [ ] Audit log of what autonomous runs did

## Done

- Chat mode for every agent (docs/chat-migration-plan.md)
- Pipelines: engine, editor, run view, MCP tool calls, templates, chat switch, run budget (docs/pipeline-design.md)
- Settings in sections
