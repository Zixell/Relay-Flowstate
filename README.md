# Relay Flowstate

**Relay Flowstate** is a desktop app for running several AI coding agents side by side — Claude Code, Codex, Gemini CLI, OpenCode, Goose — each task in its own chat and its own git worktree. Track what every agent is doing, approve what it asks for, review and revert its changes turn by turn, and pick up any conversation where you left off.

Built with Electron, React and TypeScript. Agents run through your own installed CLIs and logins; data is stored locally in SQLite — no cloud, no accounts.

---

## What it does

- **A chat per task**, like the Claude desktop app: streamed replies, collapsible reasoning, tool calls as cards with diffs, permission prompts, a plan panel, images in and out.
- **One worktree per task**, so agents work in parallel without touching your checkout or each other.
- **Status from the agent itself** — running, waiting for approval, completed, failed — straight from the agent's protocol events, no output heuristics.
- **History of changes per turn**: what each turn changed, an inline diff, one-click revert, and fork a new task from any turn.
- **Sessions that continue**: tasks resume the agent's own conversation after a restart; sessions you started in a CLI can be imported.

---

## Features

### Supported agents

| Agent | How it is driven | Fork from any turn | Session import |
|---|---|---|---|
| **Claude Code** | Claude Agent SDK, with your `claude` CLI and login | yes | yes |
| **Codex** | `codex app-server` (JSON-RPC over stdio) | yes | yes |
| **Gemini CLI** | Agent Client Protocol — `gemini --acp` | last turn | if the agent lists sessions |
| **OpenCode** | Agent Client Protocol — `opencode acp` | last turn | if the agent lists sessions |
| **Goose** | Agent Client Protocol — `goose acp` | last turn | if the agent lists sessions |

Agents whose CLI isn't on your PATH are shown as *not installed*. Sign in with each CLI once in a terminal (`claude`, `codex login`, `gemini`, `opencode auth login`, `goose configure`); Relay uses that login.

### Chat
- Replies stream in; reasoning is collapsible; code blocks are highlighted and copyable.
- Tool calls render as cards — commands with output, edits with a diff, searches, fetches, MCP tools.
- Permission prompts with the agent's own options (allow once, always allow, deny); the composer switches permission mode and model per task.
- Slash commands: type `/` for the agent's commands, skills and plugin commands.
- **Session settings** (the slider button under the composer, or `/config`): thinking, effort, output style, auto-compact, response language and next-message suggestions for this task's Claude session; Default keeps your own Claude config.
- Usage under the composer: context fill, plan limits (5-hour / weekly), session cost; tokens per turn. **Settings → Usage limits** shows each account's limits at any time.
- When an agent stops on its usage limit, the task continues by itself once the limit resets (one app-wide timer; cancel from the chat, turn off in Settings).
- Multiple-choice questions from the agent (Claude's AskUserQuestion, e.g. in plan mode) appear as a card with the options.
- Commands and subagents running in the background are listed above the composer with a Stop each; a running command or subagent can be sent to the background from its card.
- Follow-ups while a turn runs are added to it (Claude, Codex) or queued (ACP agents).

### Worktrees and git
- With **Use worktree** on (the default), each task gets a worktree and branch (`relay/task-…`) off the project's current branch, so tasks run in parallel; with it off, the agent works directly in the project folder.
- The Files tab shows everything the task changed, including new files; **Merge** asks for the target branch — an existing local one, or a new one created from the branch the worktree came from — then commits the task and squashes it into that branch.
- A plain **Console** tab opens a shell in the task's worktree — for your convenience only; nothing typed there reaches the agent.
- Projects without git (or without commits) still work, with a warning that the agent edits the folder directly.

### History of changes
- The app snapshots the working tree before and after every turn (`refs/relay/<task>/…`).
- Each turn's footer shows the files it changed — click to expand an inline diff — and **Revert** restores the files to the state before that turn.
- **Fork** starts a new task from a finished turn: its own worktree restored to the end of that turn, and the agent's conversation copied up to it.
- The Timeline lists prompts and turns with their changes.

### Sessions
- Tasks keep the agent's session id and resume that conversation after a restart.
- **Import sessions** (⤓ next to *New Task*) lists sessions you ran in the Claude Code and Codex CLIs (and ACP agents that list sessions). Import continues the session in its original folder, or — optionally — copies it into a new worktree, leaving the original untouched.
- Tasks created by older terminal-based versions of the app are converted to chats on first launch; their history is read from the agent's session the first time they are opened.

### Notifications and summaries
- A system notification when a task finishes, fails or needs approval while the app is in the background; the dock badge counts tasks waiting for you.
- After each turn a plain-English summary of the session is written by running an agent CLI headlessly (falling back to a git-based summary).

---

## Tech stack

| Layer | Technology |
|---|---|
| Shell | Electron |
| UI | React 18 + TypeScript, Tailwind CSS, Zustand |
| Agents | Claude Agent SDK · Codex app-server · Agent Client Protocol (JSON-RPC over stdio) |
| Console | node-pty + xterm.js |
| Database | SQLite via better-sqlite3 |
| Build / tests | electron-vite · Vitest |

---

## Getting started

### Prerequisites

- Node.js 18+
- Git
- At least one agent CLI installed and signed in (Claude Code, Codex, Gemini CLI, OpenCode or Goose)

### Install and run

```bash
npm install
npm run dev
```

### Updates

Installed builds check the GitHub releases at launch and from **Settings → Updates**. On Windows the update downloads in the background and installs on restart. On macOS the new `.dmg` is downloaded and opened, and you drag the app into Applications: the builds are not signed with a Developer ID, and macOS's updater refuses unsigned updates. Releases must carry `latest.yml` and the Windows installer's `.blockmap` next to the installers.

### Checks

```bash
npm run typecheck
npm test                      # unit tests, including a scripted ACP agent
RELAY_E2E=1 npm test          # also runs live tests against the installed Claude Code / Codex (spends tokens)
```

### Build for distribution

```bash
npm run build
```

The packaged app will be in `dist/`.

---

## Project structure

```
src/
  main/             # Electron main process
    agents/         # One definition per agent + chat adapters
      adapter.ts    #   the normalized event contract every adapter emits
      claude-chat.ts, codex-chat.ts, acp-chat.ts
    session/        # Session manager, status, import, fork, attachments
    console/        # Sidecar shell per task (node-pty)
    db/             # SQLite schema and queries
    git/            # Worktrees, changes, per-turn snapshots
    ipc/            # IPC handlers (bridge between main and renderer)
    summary/        # Session summaries via a headless agent CLI
    notifications.ts
  renderer/         # React frontend
    components/
      chat/         # Chat view, tool cards, composer, permission prompts, turn diffs
      dashboard/    # Task list and cards
      task/         # Task detail: console, timeline, files, notes, summary
      modals/       # New task, import sessions, settings
    hooks/ stores/ types/
  preload/          # Electron context bridge (exposes window.api)
```

---

## Adding an agent

Every agent is one `AgentDefinition` (`src/main/agents/types.ts`) whose `chat` field drives it. The session manager, the database and the UI only see the normalized `AgentEvent` stream from `adapter.ts`, so nothing else branches on which agent is running.

**An ACP agent** is a few lines:

```ts
export const myAgent: AgentDefinition = {
  id: 'my-agent',              // persisted in tasks.process_type — never change it
  label: 'My Agent',
  description: 'What it does',
  color: '#22d3ee',
  enabled: true,
  binary: 'my-agent',          // probed on PATH to report availability
  versionArgs: ['--version'],
  chat: createAcpChat({ id: 'my-agent', binary: 'my-agent', args: ['acp'], loginHint: 'Run `my-agent login` first.' }),
  settings: []
}
```

Then add it to `AGENTS` in `src/main/agents/registry.ts`. Modes, models, slash commands, permissions, plans and usage come from the agent over the protocol.

**Any other protocol** needs a `ChatSupport` implementation: `createSession` returns an `AgentSession` that emits `AgentEvent`s (see `codex-chat.ts`). Optional `history` (list / load / fork sessions) enables import and forking; optional `peek` lets the composer show commands and context before the first message. An optional `headless` command lets the agent write session summaries.

## Settings

| Key | Description |
|---|---|
| `CLAUDE_SKIP_PERMISSIONS` | New Claude sessions start in *Bypass permissions* (default) instead of *Ask before acting* |
| `CODEX_BYPASS_APPROVALS` | New Codex sessions start in *Full access* (default) instead of *Auto (sandboxed)* |
| `RELAY_NOTIFICATIONS` | System notifications for finished / failed / waiting tasks (default on) |

Agent settings are declared by the agent definition itself and rendered automatically in the Settings modal. The permission mode and model can also be changed per task under the composer.

---

## Git push setup (Windows)

Relay Flowstate uses `git push` under the hood. For it to work without prompting for a passphrase, you need SSH authentication set up correctly on Windows. Follow these steps once.

### 1. Generate an SSH key

Open **PowerShell** or **CMD**:

```powershell
ssh-keygen -t ed25519 -C "your@email.com"
```

When asked where to save it, press **Enter** to accept the default (`C:\Users\<you>\.ssh\id_ed25519`).
When asked for a passphrase, you can press **Enter** twice to leave it empty (simpler), or set one if you prefer — the remaining steps handle it either way.

### 2. Add the public key to GitHub

Copy the public key to your clipboard:

```powershell
Get-Content C:\Users\$env:USERNAME\.ssh\id_ed25519.pub | clip
```

Then go to **GitHub → Settings → SSH and GPG keys → New SSH key**, paste it, and save.

Verify it works:

```powershell
ssh -T git@github.com
# Hi <username>! You've successfully authenticated...
```

### 3. Start the Windows OpenSSH agent and add your key

Run this **once** in PowerShell as **Administrator** to enable the agent service permanently:

```powershell
Set-Service -Name ssh-agent -StartupType Automatic
Start-Service ssh-agent
```

Then add your key (no admin required):

```powershell
ssh-add C:\Users\$env:USERNAME\.ssh\id_ed25519
```

If you set a passphrase in step 1, enter it now. It will be stored in the agent — you won't be asked again after reboots.

Verify the key is loaded:

```powershell
ssh-add -l
# 256 SHA256:... your@email.com (ED25519)
```

### 4. Make Git use Windows OpenSSH

By default, Git for Windows uses its own bundled SSH (MSYS2), which does not see the Windows OpenSSH agent. Tell git to use the Windows binary instead:

```powershell
git config --global core.sshCommand "C:/Windows/System32/OpenSSH/ssh.exe"
```

### 5. Verify end-to-end

```powershell
ssh -T git@github.com
# Hi <username>! You've successfully authenticated...

git push
# works without passphrase prompt
```

After this, **Relay Flowstate's Push button will work** — the app spawns `git push` in the same environment and inherits the Windows OpenSSH agent automatically.

---

## License

MIT
