# Chat-mode migration plan

Goal: replace the per-task terminal (PTY + xterm) with a native chat UI, keeping
worktrees, task statuses, the dashboard and the git layer. Branch: `chat-mode`.

## Architecture

```
Renderer: ChatView → MessageList → ToolCallCard / PermissionPrompt / Composer
   ▲ chat:event:<taskId>         │ chat:send / interrupt / permission / setMode
Main: SessionManager (src/main/session)
   ├─ AgentAdapter per transport: ClaudeAdapter (Agent SDK), CodexAdapter (app-server), AcpAdapter
   ├─ StatusMachine   — status from events, no inactivity timers
   ├─ MessageStore    — turns + messages tables
   └─ TurnSnapshotter — git snapshot before/after every turn
```

Agents normalize everything into `AgentEvent` (`src/main/agents/adapter.ts`).
UI and DB never see agent-specific shapes.

## Sidecar console

Each task keeps an optional plain shell (xterm + node-pty) opened in its worktree,
like an IDE's built-in terminal. It is purely for convenience: no agent is launched
in it, its output is never parsed, it never affects status, history or summaries.
Users on a Claude Pro/Max login can still run `claude` there by hand.

## Status mapping

| Event | Status |
|---|---|
| send / turn.started | running |
| permission.requested | waiting |
| permission answered | running |
| turn.completed (end_turn) | completed |
| turn.completed (interrupted) | paused |
| fatal error / exit mid-turn | failed |

## Phases

- [x] 0. Spike: Claude Agent SDK from Electron's Node — streaming input, canUseTool, resume (OK, SDK 0.3.301, CLI 2.1.301)
- [x] 1. Foundation: adapter contract, DB (turns, messages, tasks.transport), StatusMachine, SessionManager, chat:* IPC (mock adapter skipped — the live Claude adapter was ready first)
- [x] 2. ClaudeAdapter + chat UI (ChatView, Composer, PermissionPrompt, ToolCallCard, PlanPanel), "Chat mode" setting, sidecar Console tab
- [x] 3. History & polish
  - [x] per-turn git snapshots, turn footer with file stats and revert
  - [x] summaries from the chat transcript
  - [x] per-turn diff viewer (inline under each turn's footer), Timeline turn events show the same diffs
  - [x] long chats: render the last 150 messages + "show earlier", `content-visibility: auto`; syntax highlighting + copy button in code blocks
  - [x] persist the agent plan across restarts (tasks.plan_json); user-attached images in history
  - [x] dashboard TaskCard: last assistant message instead of terminal preview, "Needs approval" badge
  - [x] Files tab and changed-files count include new untracked files (merge stages them with `git add -A` anyway)
- [x] 4. CodexAdapter (`codex app-server`, JSON-RPC over stdio, `src/main/agents/codex-chat.ts`)
  - modes map to approval policy + sandbox (Ask / Auto sandboxed / Read only / Full access); the worktree's git common dir is a writable root
  - models from `~/.codex/models_cache.json`, refreshed via `model/list`; follow-ups during a turn use `turn/steer`
  - live test: `RELAY_E2E=1 npx vitest run src/main/agents/codex-chat.e2e.test.ts`
- [x] Import of sessions started outside the app (`src/main/session/import.ts`, sidebar ⤓ button)
  - Claude via Agent SDK `listSessions`/`getSessionMessages`/`forkSession`; Codex via app-server `thread/list`/`thread/read`/`thread/fork`
  - default: continue the same session in its original folder; option: fork it into a new worktree
  - history is replayed through the adapters' live mappers; imported turns have no snapshots (no per-turn diff/revert)
- [ ] 5. AcpAdapter (Gemini CLI, OpenCode, Goose)
- [ ] 6. Parity: slash commands, attachments, usage/cost, notifications, fork-from-turn, sidecar console (plain shell, no logic)
- [ ] 7. Remove legacy PTY agent path (keep node-pty only for the sidecar console), convert old Claude/Codex tasks (same session id), update README

## Notes

- Resolve the `claude` binary to an absolute path (GUI apps on macOS don't inherit shell PATH) and pass it as `pathToClaudeCodeExecutable`, so the user's own CLI and login are used.
- Persist only final messages; stream deltas over IPC only.
- Check Anthropic's terms before shipping any sign-in flow other than the user's own CLI login / API key.
