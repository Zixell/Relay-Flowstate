import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  RotateCcw,
  Smartphone,
  SquareTerminal,
  XCircle
} from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/dialog'
import { TerminalPane } from '../ui/terminal-pane'
import { cn } from '../../lib/utils'
import { useAppStore } from '../../stores/appStore'
import type { AgentDescriptor, AuthStatus, LoginMethod } from '../../types'

/** Strips Electron's wrapper from an IPC error. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
}

/** The agent's sign-in status; `refresh` asks the CLI again. */
export function useAuthStatus(agentId: string | null): { status: AuthStatus | null; refresh: () => Promise<AuthStatus | null> } {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const refresh = useCallback(async () => {
    if (!agentId || !window.api) return null
    const next = await window.api.auth.status(agentId).catch(() => ({ signedIn: null }) as AuthStatus)
    setStatus(next)
    return next
  }, [agentId])
  useEffect(() => {
    setStatus(null)
    void refresh()
  }, [refresh])
  return { status, refresh }
}

type Step =
  | { kind: 'choose' }
  | { kind: 'apiKey'; method: LoginMethod }
  | { kind: 'starting' }
  | { kind: 'browser'; url?: string; acceptsCode: boolean; codeSent?: boolean }
  | { kind: 'device'; url: string; code: string }
  | { kind: 'terminal'; method: LoginMethod; exited: boolean }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

const METHOD_ICONS: Record<LoginMethod['kind'], React.ElementType> = {
  browser: Globe,
  device: Smartphone,
  apiKey: KeyRound,
  terminal: SquareTerminal
}

/** One sentence on who is signed in. */
export function describeStatus(status: AuthStatus | null): string {
  if (!status) return 'Checking…'
  if (status.signedIn === false) return 'Not signed in'
  if (status.signedIn === null) return 'Sign-in status unknown'
  return [status.account ? `Signed in as ${status.account}` : 'Signed in', status.detail].filter(Boolean).join(' · ')
}

/** Mounted once per window; opened with `openSignIn(agentId)` from anywhere. */
export function SignInHost() {
  const agentId = useAppStore((s) => s.signInAgentId)
  const close = useAppStore((s) => s.closeSignIn)
  const agent = useAppStore((s) => s.agents.find((a) => a.id === agentId))
  return <SignInDialog agent={agent ?? null} onClose={close} />
}

function SignInDialog({ agent, onClose }: { agent: AgentDescriptor | null; onClose: () => void }) {
  const { status, refresh } = useAuthStatus(agent?.id ?? null)
  const [step, setStep] = useState<Step>({ kind: 'choose' })
  const flowId = useRef<string | null>(null)
  /** Flows given up on; their late events are ignored. */
  const abandoned = useRef(new Set<string>())

  const cancelFlow = useCallback(() => {
    if (flowId.current) {
      abandoned.current.add(flowId.current)
      void window.api.auth.cancel(flowId.current)
    }
    flowId.current = null
  }, [])

  const reset = useCallback(() => {
    cancelFlow()
    setStep({ kind: 'choose' })
  }, [cancelFlow])

  // A fresh dialog for every agent; a running sign-in is cancelled on close.
  useEffect(() => {
    setStep({ kind: 'choose' })
    return cancelFlow
  }, [agent?.id, cancelFlow])

  useEffect(() => {
    if (!agent || !window.api) return
    return window.api.auth.onUpdate(({ flowId: id, agentId, update }) => {
      if (agentId !== agent.id || abandoned.current.has(id) || (flowId.current && id !== flowId.current)) return
      switch (update.stage) {
        case 'starting':
          return setStep({ kind: 'starting' })
        case 'browser':
          return setStep((s) => ({ kind: 'browser', url: update.url, acceptsCode: update.acceptsCode, codeSent: s.kind === 'browser' && s.codeSent }))
        case 'device':
          return setStep({ kind: 'device', url: update.url, code: update.code })
        case 'done':
          flowId.current = null
          void refresh()
          return setStep({ kind: 'done' })
        case 'error':
          flowId.current = null
          return setStep({ kind: 'error', message: update.message })
      }
    })
  }, [agent, refresh])

  const start = useCallback(
    async (method: LoginMethod, apiKey?: string) => {
      if (!agent) return
      if (method.kind === 'terminal') return setStep({ kind: 'terminal', method, exited: false })
      if (method.kind === 'apiKey' && apiKey === undefined) return setStep({ kind: 'apiKey', method })
      setStep({ kind: 'starting' })
      try {
        flowId.current = await window.api.auth.login(agent.id, method.id, apiKey)
      } catch (err) {
        setStep({ kind: 'error', message: errorText(err) })
      }
    },
    [agent]
  )

  const handleClose = (): void => {
    if (step.kind === 'terminal' && agent) void window.api.console.close(`login:${agent.id}`)
    onClose()
  }

  const wide = step.kind === 'terminal'
  const back = step.kind !== 'choose' && step.kind !== 'done' && (agent?.loginMethods.length ?? 0) > 0

  return (
    <Dialog open={Boolean(agent)} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className={cn('p-0 overflow-hidden transition-[max-width] duration-200', wide ? 'max-w-3xl' : 'max-w-md')}>
        {agent && (
          <>
            {/* Header: the agent's mark on a soft glow of its colour */}
            <div className="relative px-6 pt-6 pb-5 overflow-hidden">
              <div
                className="absolute -top-24 left-1/2 -translate-x-1/2 w-80 h-48 rounded-full blur-3xl opacity-25 pointer-events-none"
                style={{ backgroundColor: agent.color }}
              />
              <div className="relative flex items-center gap-3.5">
                {back && (
                  <button
                    onClick={() => {
                      if (step.kind === 'terminal') void window.api.console.close(`login:${agent.id}`)
                      reset()
                    }}
                    className="-ml-1.5 p-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-white/5"
                    title="Back"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                )}
                <AgentMark agent={agent} />
                <div className="min-w-0">
                  <DialogTitle>Sign in to {agent.label}</DialogTitle>
                  <DialogDescription className="text-[12px] text-zinc-500 mt-0.5 truncate">
                    <StatusDot status={status} /> {describeStatus(status)}
                  </DialogDescription>
                </div>
              </div>
            </div>

            <div className="px-6 pb-6">
              {!agent.available ? (
                <p className="text-[12.5px] text-zinc-400 leading-relaxed">
                  {agent.label} is not installed. Install its CLI, then sign in here.
                </p>
              ) : step.kind === 'choose' ? (
                <MethodList methods={agent.loginMethods} onPick={(m) => void start(m)} status={status} agent={agent} onSignedOut={refresh} />
              ) : step.kind === 'apiKey' ? (
                <ApiKeyStep method={step.method} onSubmit={(key) => void start(step.method, key)} />
              ) : step.kind === 'starting' ? (
                <Centered icon={<Loader2 className="w-6 h-6 animate-spin text-zinc-400" />} title="Starting sign-in…" />
              ) : step.kind === 'browser' ? (
                <BrowserStep
                  step={step}
                  onCode={(code) => {
                    if (!flowId.current) return
                    void window.api.auth.submitCode(flowId.current, code)
                    setStep({ ...step, codeSent: true })
                  }}
                />
              ) : step.kind === 'device' ? (
                <DeviceStep url={step.url} code={step.code} />
              ) : step.kind === 'terminal' ? (
                <TerminalStep
                  agent={agent}
                  method={step.method}
                  exited={step.exited}
                  onExit={() => {
                    setStep({ ...step, exited: true })
                    void refresh().then((s) => s?.signedIn && setStep({ kind: 'done' }))
                  }}
                  onRestart={() => setStep({ kind: 'terminal', method: step.method, exited: false })}
                />
              ) : step.kind === 'done' ? (
                <Centered
                  icon={
                    <div className="w-12 h-12 rounded-full bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center animate-in zoom-in-50 duration-300">
                      <Check className="w-6 h-6 text-emerald-400" />
                    </div>
                  }
                  title="You're signed in"
                  text={status?.signedIn ? describeStatus(status) : undefined}
                  action={<PrimaryButton onClick={handleClose}>Done</PrimaryButton>}
                />
              ) : (
                <Centered
                  icon={<XCircle className="w-8 h-8 text-red-400" />}
                  title="Sign-in failed"
                  text={step.message}
                  action={
                    <PrimaryButton onClick={reset}>
                      <RotateCcw className="w-3.5 h-3.5" /> Try again
                    </PrimaryButton>
                  }
                />
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function AgentMark({ agent }: { agent: AgentDescriptor }) {
  return (
    <div
      className="w-10 h-10 rounded-xl flex items-center justify-center text-[15px] font-semibold text-white shrink-0 shadow-lg"
      style={{ background: `linear-gradient(135deg, ${agent.color}, ${agent.color}99)`, boxShadow: `0 6px 24px -6px ${agent.color}80` }}
    >
      {agent.label.charAt(0)}
    </div>
  )
}

export function StatusDot({ status }: { status: AuthStatus | null }) {
  return (
    <span
      className={cn(
        'inline-block w-1.5 h-1.5 rounded-full align-middle mb-px',
        !status ? 'bg-zinc-600 animate-pulse' : status.signedIn ? 'bg-emerald-400' : status.signedIn === false ? 'bg-amber-400' : 'bg-zinc-500'
      )}
    />
  )
}

function PrimaryButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="h-8 px-4 rounded-lg text-[12.5px] font-medium bg-white text-zinc-900 hover:bg-zinc-200 disabled:opacity-40 disabled:hover:bg-white flex items-center justify-center gap-1.5 transition-colors"
    >
      {children}
    </button>
  )
}

function SecondaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="h-8 px-3 rounded-lg text-[12px] font-medium border border-white/10 text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100 flex items-center gap-1.5 transition-colors"
    >
      {children}
    </button>
  )
}

function Centered({ icon, title, text, action }: { icon: React.ReactNode; title: string; text?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center text-center gap-3 py-4">
      {icon}
      <div>
        <p className="text-[13.5px] font-medium text-zinc-100">{title}</p>
        {text && <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed whitespace-pre-wrap break-words max-w-sm">{text}</p>}
      </div>
      {action}
    </div>
  )
}

function MethodList({
  agent,
  methods,
  status,
  onPick,
  onSignedOut
}: {
  agent: AgentDescriptor
  methods: LoginMethod[]
  status: AuthStatus | null
  onPick: (m: LoginMethod) => void
  onSignedOut: () => Promise<AuthStatus | null>
}) {
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const signOut = async (): Promise<void> => {
    setSigningOut(true)
    setError(null)
    try {
      await window.api.auth.logout(agent.id)
      await onSignedOut()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {status?.signedIn && (
        <p className="text-[11.5px] text-zinc-500 mb-1">Sign in again to switch accounts or renew an expired sign-in.</p>
      )}
      {methods.map((m) => {
        const Icon = METHOD_ICONS[m.kind]
        return (
          <button
            key={m.id}
            onClick={() => onPick(m)}
            className="group flex items-center gap-3 px-3.5 py-3 rounded-xl border border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/[0.14] text-left transition-colors"
          >
            <div className="w-8 h-8 rounded-lg bg-white/[0.05] border border-white/[0.06] flex items-center justify-center shrink-0">
              <Icon className="w-4 h-4 text-zinc-300" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium text-zinc-100">{m.label}</p>
              <p className="text-[11.5px] text-zinc-500 mt-0.5 leading-snug">{m.description}</p>
            </div>
            <ChevronRight className="w-4 h-4 text-zinc-600 group-hover:text-zinc-300 group-hover:translate-x-0.5 transition-all shrink-0" />
          </button>
        )
      })}
      {agent.canLogout && status?.signedIn && (
        <button
          onClick={() => void signOut()}
          disabled={signingOut}
          className="self-center mt-2 text-[11.5px] text-zinc-500 hover:text-red-300 disabled:opacity-50 flex items-center gap-1.5"
        >
          {signingOut && <Loader2 className="w-3 h-3 animate-spin" />}
          Sign out
        </button>
      )}
      {error && <p className="text-[11.5px] text-red-400 text-center">{error}</p>}
    </div>
  )
}

function ApiKeyStep({ method, onSubmit }: { method: LoginMethod; onSubmit: (key: string) => void }) {
  const [key, setKey] = useState('')
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (key.trim()) onSubmit(key.trim())
      }}
    >
      <label className="text-[12px] text-zinc-400">{method.label}</label>
      <input
        autoFocus
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="sk-…"
        spellCheck={false}
        className="h-9 px-3 rounded-lg bg-black/40 border border-white/10 focus:border-white/25 outline-none text-[12.5px] font-mono text-zinc-100 placeholder:text-zinc-600"
      />
      <p className="text-[11px] text-zinc-500">The key is handed to the agent's CLI, which stores it. Relay keeps no copy.</p>
      <div className="flex justify-end">
        <PrimaryButton onClick={() => key.trim() && onSubmit(key.trim())} disabled={!key.trim()}>
          Sign in
        </PrimaryButton>
      </div>
    </form>
  )
}

function CopyButton({ text, label = 'Copy link' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <SecondaryButton
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      {copied ? 'Copied' : label}
    </SecondaryButton>
  )
}

/** A pulsing ring around an icon — "waiting for something elsewhere". */
function Waiting({ icon: Icon }: { icon: React.ElementType }) {
  return (
    <div className="relative w-14 h-14 flex items-center justify-center">
      <span className="absolute inset-0 rounded-full border border-white/10 animate-ping [animation-duration:2s]" />
      <span className="absolute inset-1 rounded-full bg-white/[0.04] border border-white/10" />
      <Icon className="relative w-6 h-6 text-zinc-300" />
    </div>
  )
}

function BrowserStep({
  step,
  onCode
}: {
  step: { url?: string; acceptsCode: boolean; codeSent?: boolean }
  onCode: (code: string) => void
}) {
  const [code, setCode] = useState('')
  return (
    <div className="flex flex-col gap-4">
      <Centered
        icon={<Waiting icon={Globe} />}
        title="Finish signing in in your browser"
        text="A browser tab has opened. Sign in there, and this window updates by itself."
        action={
          step.url ? (
            <div className="flex items-center gap-2">
              <SecondaryButton onClick={() => window.open(step.url, '_blank')}>
                <ExternalLink className="w-3.5 h-3.5" /> Open browser again
              </SecondaryButton>
              <CopyButton text={step.url} />
            </div>
          ) : undefined
        }
      />
      {step.acceptsCode && (
        <form
          className="flex flex-col gap-2 pt-4 border-t border-white/[0.06]"
          onSubmit={(e) => {
            e.preventDefault()
            if (code.trim()) onCode(code.trim())
          }}
        >
          <label className="text-[11.5px] text-zinc-400">The page shows a code instead? Paste it here:</label>
          <div className="flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Authentication code"
              spellCheck={false}
              className="flex-1 min-w-0 h-8 px-3 rounded-lg bg-black/40 border border-white/10 focus:border-white/25 outline-none text-[12px] font-mono text-zinc-100 placeholder:text-zinc-600"
            />
            <PrimaryButton onClick={() => code.trim() && onCode(code.trim())} disabled={!code.trim() || step.codeSent}>
              {step.codeSent ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Continue'}
            </PrimaryButton>
          </div>
        </form>
      )}
    </div>
  )
}

function DeviceStep({ url, code }: { url: string; code: string }) {
  return (
    <Centered
      icon={<Waiting icon={Smartphone} />}
      title="Enter this code on the sign-in page"
      text={`Open ${url.replace(/^https?:\/\//, '')} on any device and enter:`}
      action={
        <div className="flex flex-col items-center gap-3">
          <div className="px-5 py-2.5 rounded-xl bg-black/40 border border-white/10 font-mono text-[22px] tracking-[0.2em] text-zinc-100 select-all">
            {code}
          </div>
          <div className="flex items-center gap-2">
            <SecondaryButton onClick={() => window.open(url, '_blank')}>
              <ExternalLink className="w-3.5 h-3.5" /> Open page
            </SecondaryButton>
            <CopyButton text={code} label="Copy code" />
          </div>
        </div>
      }
    />
  )
}

function TerminalStep({
  agent,
  method,
  exited,
  onExit,
  onRestart
}: {
  agent: AgentDescriptor
  method: LoginMethod
  exited: boolean
  onExit: () => void
  onRestart: () => void
}) {
  const [generation, setGeneration] = useState(0)
  const open = useCallback(
    async (cols: number, rows: number) => {
      const r = await window.api.auth.openTerminal(agent.id, cols, rows)
      return { available: r.available, scrollback: r.scrollback }
    },
    [agent.id]
  )
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-zinc-400 leading-relaxed">{method.description}</p>
      <div className="relative rounded-xl overflow-hidden border border-white/[0.08]">
        <TerminalPane key={generation} consoleId={`login:${agent.id}`} open={open} onExit={onExit} className="h-[340px] bg-[#0a0a0a]" />
        {exited && (
          <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px] flex flex-col items-center justify-center gap-3">
            <p className="text-[12.5px] text-zinc-300">The sign-in finished.</p>
            <SecondaryButton
              onClick={() => {
                setGeneration((g) => g + 1)
                onRestart()
              }}
            >
              <RotateCcw className="w-3.5 h-3.5" /> Run again
            </SecondaryButton>
          </div>
        )}
      </div>
      <p className="text-[11px] text-zinc-600">
        Paste with {navigator.platform.toUpperCase().includes('MAC') ? '⌘V' : 'Ctrl+V'} or a right click. Links open in your browser.
      </p>
    </div>
  )
}
