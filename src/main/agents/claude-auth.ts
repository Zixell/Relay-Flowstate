import type { AgentAuth, AuthStatus, LoginUpdate } from './types'
import { lastLine, runCli, spawnInPty, stripAnsi } from './cli-auth'

/**
 * Claude Code sign-in through `claude auth`. Login runs in a hidden terminal:
 * the CLI opens the browser and finishes on its own when the browser can reach
 * it, or waits for the code the sign-in page shows — that code is typed into
 * its prompt from the app.
 */

const PLANS: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' }

interface ClaudeAuthStatus {
  loggedIn?: boolean
  authMethod?: string
  apiProvider?: string
  email?: string
  orgName?: string
  subscriptionType?: string
}

async function status(): Promise<AuthStatus> {
  const r = await runCli('claude', ['auth', 'status', '--json'])
  let s: ClaudeAuthStatus
  try {
    s = JSON.parse(r.stdout) as ClaudeAuthStatus
  } catch {
    // A CLI older than `claude auth`
    return { signedIn: null }
  }
  if (!s.loggedIn) return { signedIn: false }
  if (s.apiProvider && s.apiProvider !== 'firstParty') return { signedIn: true, detail: s.apiProvider }
  const plan = s.subscriptionType ? PLANS[s.subscriptionType] ?? s.subscriptionType : undefined
  const detail = plan ?? (s.authMethod === 'claude.ai' ? 'Claude account' : s.authMethod === 'console' ? 'Anthropic Console' : 'API key')
  return { signedIn: true, account: s.email ?? s.orgName, detail }
}

export const claudeAuth: AgentAuth = {
  methods: [
    {
      id: 'claudeai',
      label: 'Claude subscription',
      description: 'Pro, Max, Team or Enterprise plan',
      kind: 'browser'
    },
    {
      id: 'console',
      label: 'Anthropic Console',
      description: 'Pay per use with API billing',
      kind: 'browser'
    }
  ],

  status,

  login(methodId, _input, onUpdate) {
    const proc = spawnInPty('claude', ['auth', 'login', methodId === 'console' ? '--console' : '--claudeai'])
    let output = ''
    let url: string | undefined
    let confirmed = false
    let finished = false
    const finish = (u: LoginUpdate): void => {
      if (finished) return
      finished = true
      onUpdate(u)
    }

    proc.onData((data) => {
      output = (output + data).slice(-50_000)
      const text = stripAnsi(output)
      if (!url) {
        url = /https:\/\/\S+oauth\/authorize\S+/.exec(text)?.[0]
        if (url) onUpdate({ stage: 'browser', url, acceptsCode: true })
      }
      // Some versions wait for Enter after a successful login.
      if (!confirmed && /login successful|logged in as/i.test(text)) {
        confirmed = true
        proc.write('\r')
      }
    })
    proc.onExit(({ exitCode }) => {
      if (exitCode === 0) finish({ stage: 'done' })
      else finish({ stage: 'error', message: lastLine(output) ?? `claude auth login exited with code ${exitCode}` })
    })
    onUpdate({ stage: 'starting' })

    return {
      submitCode(code) {
        proc.write(code.trim())
        setTimeout(() => proc.write('\r'), 100)
      },
      cancel() {
        finished = true
        try {
          proc.kill()
        } catch {
          // already gone
        }
      }
    }
  },

  async logout() {
    const r = await runCli('claude', ['auth', 'logout'])
    if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) ?? 'claude auth logout failed')
  }
}
