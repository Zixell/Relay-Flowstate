import { homedir } from 'os'
import { shell } from 'electron'
import type { AgentAuth, AuthStatus, LoginUpdate } from './types'
import { RpcError, type JsonRpcProcess } from './jsonrpc'
import { startAppServer, withAppServer } from './codex-chat'

/** Codex sign-in through the app-server's `account/*` API. */

type Account = { type: 'apiKey' } | { type: 'chatgpt'; email: string | null; planType: string } | { type: string }

type LoginResponse =
  | { type: 'chatgpt'; loginId: string; authUrl: string }
  | { type: 'chatgptDeviceCode'; loginId: string; verificationUrl: string; userCode: string }
  | { type: 'apiKey' }

function planLabel(plan: string): string {
  if (!plan || plan === 'unknown') return 'ChatGPT'
  return `ChatGPT ${plan.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())}`
}

async function status(): Promise<AuthStatus> {
  const { account } = await withAppServer((rpc) => rpc.request<{ account: Account | null }>('account/read', {}))
  if (!account) return { signedIn: false }
  if (account.type === 'chatgpt' && 'email' in account) {
    return { signedIn: true, account: account.email ?? undefined, detail: planLabel(account.planType) }
  }
  if (account.type === 'apiKey') return { signedIn: true, detail: 'OpenAI API key' }
  return { signedIn: true, detail: account.type }
}

export const codexAuth: AgentAuth = {
  methods: [
    { id: 'chatgpt', label: 'ChatGPT account', description: 'Plus, Pro, Team or Enterprise plan', kind: 'browser' },
    { id: 'device', label: 'Sign in with a code', description: 'When this computer’s browser can’t finish the sign-in', kind: 'device' },
    { id: 'apiKey', label: 'OpenAI API key', description: 'Pay per use with API billing', kind: 'apiKey' }
  ],

  status,

  login(methodId, input, onUpdate) {
    let rpc: JsonRpcProcess | null = null
    let loginId: string | null = null
    let finished = false
    const finish = (u: LoginUpdate): void => {
      if (finished) return
      finished = true
      onUpdate(u)
      rpc?.kill()
    }

    void (async () => {
      rpc = await startAppServer(homedir(), {
        onNotification: (method, params) => {
          if (method !== 'account/login/completed') return
          const p = params as { loginId: string | null; success: boolean; error: string | null }
          if (loginId && p.loginId && p.loginId !== loginId) return
          finish(p.success ? { stage: 'done' } : { stage: 'error', message: p.error || 'Sign-in failed' })
        },
        onRequest: () => Promise.reject(new RpcError('Not supported', -32601)),
        onExit: () => finish({ stage: 'error', message: 'Codex stopped before the sign-in finished' })
      })
      if (finished) return rpc.kill()

      const params =
        methodId === 'apiKey'
          ? { type: 'apiKey', apiKey: (input.apiKey ?? '').trim() }
          : methodId === 'device'
            ? { type: 'chatgptDeviceCode' }
            : { type: 'chatgpt' }
      const res = await rpc.request<LoginResponse>('account/login/start', params)
      if (res.type === 'chatgpt') {
        loginId = res.loginId
        onUpdate({ stage: 'browser', url: res.authUrl, acceptsCode: false })
        void shell.openExternal(res.authUrl)
      } else if (res.type === 'chatgptDeviceCode') {
        loginId = res.loginId
        onUpdate({ stage: 'device', url: res.verificationUrl, code: res.userCode })
      } else {
        finish({ stage: 'done' })
      }
    })().catch((err) => finish({ stage: 'error', message: err instanceof Error ? err.message : String(err) }))

    onUpdate({ stage: 'starting' })

    return {
      cancel() {
        if (finished) return
        finished = true
        const r = rpc
        if (!r) return
        if (loginId) void r.request('account/login/cancel', { loginId }).catch(() => {}).finally(() => r.kill())
        else r.kill()
      }
    }
  },

  async logout() {
    await withAppServer((rpc) => rpc.request('account/logout', {}))
  }
}
