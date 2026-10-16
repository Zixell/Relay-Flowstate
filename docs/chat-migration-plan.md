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
- [ ] 1. Foundation: adapter contract, DB (turns, messages, tasks.transport), StatusMachine, SessionManager, chat:* IPC, mock adapter
- [ ] 2. ClaudeAdapter + minimal chat UI (ChatView, Composer, PermissionPrompt), "Chat mode" toggle
- [ ] 3. Rich tool cards, virtualized history, per-turn git snapshots (diff / revert), summaries from messages
- [ ] 4. CodexAdapter (`codex app-server`) — codex CLI not installed on dev machine yet
- [ ] 5. AcpAdapter (Gemini CLI, OpenCode, Goose)
- [ ] 6. Parity: slash commands, attachments, usage/cost, notifications, fork-from-turn, sidecar console (plain shell, no logic)
- [ ] 7. Remove legacy PTY agent path (keep node-pty only for the sidecar console), convert old Claude/Codex tasks (same session id), update README

## Notes

- Resolve the `claude` binary to an absolute path (GUI apps on macOS don't inherit shell PATH) and pass it as `pathToClaudeCodeExecutable`, so the user's own CLI and login are used.
- Persist only final messages; stream deltas over IPC only.
- Check Anthropic's terms before shipping any sign-in flow other than the user's own CLI login / API key.
