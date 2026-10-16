# Relay Flowstate

**Relay Flowstate** is a desktop app for managing multiple AI coding agent sessions in one place. Run Claude Code, Codex, or any CLI agent in parallel — track their progress, review changes, and pick up where you left off.

Built with Electron, React, and TypeScript. Data is stored locally via SQLite — no cloud, no accounts.

---

## What it does

Modern AI coding agents are powerful but hard to manage when you have multiple tasks running across different projects. Relay Flowstate solves this by giving you:

- A unified dashboard across all running agents
- A real terminal inside each task — full PTY, no limitations
- Git-aware file change tracking scoped to each session
- Automatic session summaries so you always know what happened
- Session resume that picks up each agent's own conversation where it left off

---

## Features

### Multi-agent dashboard
See all your tasks at a glance — grouped by status (Running, Waiting for Input, Completed, Failed), with live status indicators, runtime counters, and a terminal preview of the latest output.

### Supported agents

| Agent | Launch | Session resume | Summaries |
|---|---|---|---|
| **Claude Code** | `claude --dangerously-skip-permissions` | `claude --resume <id>` | `claude --print` |
| **Codex** | `codex --dangerously-bypass-approvals-and-sandbox "<prompt>"` | `codex resume <id>` | `codex exec --json` |
| **Aider**, **OpenCode**, **Generic CLI** | defined, not yet enabled in the picker | — | — |

Every agent is one file in `src/main/agents/` — see [Adding an agent](#adding-an-agent).
Agents whose CLI isn't on your PATH are shown as *not installed* in the picker and in Settings.

### Full terminal emulator
Each task has a real pseudo-terminal (PTY) with xterm-256color and true color support. Type directly, resize the terminal, send interrupts — it behaves exactly like a real terminal.

### Smart status tracking
Relay Flowstate monitors agent output to detect state automatically:
- **Running** — agent is producing output
- **Waiting for Input** — agent has been idle for 15 seconds and appears to be waiting
- **Completed** — agent stopped producing output (inactivity window elapsed)
- **Failed** — process exited with a non-zero code

Status is locked after completion or when waiting, and only unlocks when you send a new prompt — preventing false "running" flickers.

### Git integration
Each task tracks its own git branch. Relay Flowstate can:
- Create a new branch or checkout an existing one before starting a session
- Show committed and uncommitted file changes scoped to the task branch
- Display additions/deletions per file with change type (added, modified, deleted, renamed)
- Scope the diff using the commit recorded at session start

### Automatic session summaries
When a task completes or goes idle, Relay Flowstate generates a plain-English summary of the session by running an agent CLI headlessly — the task's own agent first, then any other installed one. The summary includes:
- What was accomplished (2-4 sentences, action-verb style)
- Which files were modified
- Which commits were made

If no agent CLI is available, Relay Flowstate falls back to a git-based summary.

### Session resume
Each agent records its conversation in its own session store (`~/.claude/projects` for Claude Code, `~/.codex/sessions` for Codex). Relay Flowstate snapshots that directory before launching, captures the id of the session file the agent creates, and stores it on the task. Restarting the task then resumes that exact conversation instead of starting over.

Restart resolves in three steps, and the terminal states which one was used:

| Situation | What runs | Terminal says |
|---|---|---|
| Session id captured | `claude --resume <id>` / `codex resume <id>` | Session resumed |
| No id, but the agent can continue by directory | `claude --continue` | Continued latest conversation in this directory |
| Nothing to continue | plain launch | New session started |

The middle step is per-agent and opt-in: it exists for Claude Code, whose `--continue` is scoped to the working directory. Codex deliberately has no fallback — its `resume --last` is global and would adopt another task's conversation. Starting a **new** task never uses this path, so a fresh task always gets a fresh conversation.

### Project management
Organize tasks under projects. Each project has a name, file path, and optional description. Filter the dashboard by project to focus on what matters.

### Local-first, persistent storage
All data (projects, tasks, terminal logs, events, summaries) is stored in a local SQLite database. Nothing leaves your machine. Data persists across app restarts — tasks that were running are reset to a safe state on relaunch.

---

## Tech stack

| Layer | Technology |
|---|---|
| Shell | Electron |
| UI | React 18 + TypeScript |
| Styling | Tailwind CSS |
| State | Zustand |
| Terminal | node-pty + xterm.js |
| Database | SQLite via better-sqlite3 |
| Build | Vite + electron-vite |

---

## Getting started

### Prerequisites

- Node.js 18+
- Git
- Claude Code or Codex installed and available on PATH (at least one)

### Install and run

```bash
npm install
npm run dev
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
  main/           # Electron main process
    agents/       # Agent abstraction — one file per supported agent
    db/           # SQLite schema and queries
    git/          # Git branch management and diff parsing
    ipc/          # IPC handlers (bridge between main and renderer)
    pty/          # PTY session lifecycle and status detection
    summary/      # Session summary generation via a headless agent CLI
    settings.ts   # App settings (persisted in DB)
  renderer/       # React frontend
    components/
      dashboard/  # Task list, task cards, summary bar
      layout/     # Top bar, navigation
      ui/         # Shared UI primitives (Button, Badge, Input, etc.)
    stores/       # Zustand app state
    types/        # Shared TypeScript types
  preload/        # Electron context bridge (exposes window.api)
```

---

## Adding an agent

All agent-specific knowledge lives behind one interface, `AgentDefinition` (`src/main/agents/types.ts`). Nothing in the PTY manager, the summary generator, the IPC layer or the UI branches on which agent is running.

1. Create `src/main/agents/<your-agent>.ts` exporting an `AgentDefinition`:

```ts
export const myAgent: AgentDefinition = {
  id: 'my-agent',              // persisted in tasks.process_type — never change it
  label: 'My Agent',
  description: 'What it does',
  color: '#22d3ee',
  enabled: true,

  binary: 'my-agent',          // probed on PATH to report availability
  versionArgs: ['--version'],

  tracked: true,               // enable status detection + summaries
  promptDelivery: 'arg',       // 'arg' | 'input' | 'none'

  buildLaunchCommand: ({ prompt, getBool }) => ({ cmd: 'my-agent', args: [...] }),
  buildResumeCommand: ({ resumeSessionId }) =>
    resumeSessionId ? { cmd: 'my-agent', args: ['resume', resumeSessionId] } : null,

  // Optional: only if the agent continues the newest conversation *of this
  // directory*. Omit when its "continue" is global — it would adopt another
  // task's session. Guarded by hasSessionForCwd.
  buildContinueCommand: () => ({ cmd: 'my-agent', args: ['--continue'] }),
  hasSessionForCwd: (cwd) => existsSync(sessionDirFor(cwd)),

  sessionDiscovery: {          // where the agent records conversations
    rootDir: join(homedir(), '.my-agent', 'sessions'),
    filePattern: /^session-(.+)\.jsonl$/   // capture group 1 = resume id
  },

  headless: {                  // used to write session summaries
    cmd: 'my-agent', args: ['run', '--quiet'], promptVia: 'stdin'
  },

  settings: [/* toggles rendered automatically in the Settings modal */]
}
```

2. Add it to the `AGENTS` array in `src/main/agents/registry.ts`.

That's it. The agent picker, the availability badges, the Settings toggles, status tracking, session resume and summary generation all pick it up from the catalog served by `agents:list`.

**Prompt delivery** is the one thing worth choosing carefully:
- `'arg'` — the prompt goes on the command line and the agent starts working immediately (Codex). Most reliable; newlines are collapsed on Windows since `cmd.exe` cannot represent them.
- `'input'` — the prompt is typed into the TUI once it signals readiness (Claude Code). Provide `promptReadyPattern` so delivery is fast; without one it falls back to silence detection.
- `'none'` — the agent takes no prompt (plain shell).

## Settings

| Key | Description |
|---|---|
| `CLAUDE_SKIP_PERMISSIONS` | When not `false`, launches Claude Code with `--dangerously-skip-permissions` |
| `CODEX_BYPASS_APPROVALS` | When not `false`, launches Codex with `--dangerously-bypass-approvals-and-sandbox`; otherwise `--full-auto` |

Agent settings are declared by the agent definition itself and rendered automatically — there is no UI to update when you add one.

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
