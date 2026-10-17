import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'child_process'
import { createInterface } from 'readline'

type Id = string | number

export interface RpcRequest {
  id: Id
  method: string
  params: unknown
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown
  ) {
    super(message)
  }
}

interface Handlers {
  onNotification: (method: string, params: unknown) => void
  /** Requests the agent sends to us (approvals). The returned value is the result. */
  onRequest: (req: RpcRequest) => Promise<unknown>
  onExit: (code: number | null) => void
  onStderr?: (text: string) => void
}

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio — the transport
 * of `codex app-server` and of ACP agents.
 */
export class JsonRpcProcess {
  private proc: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<Id, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private exited = false
  /** Set by kill(): stdin is ending, nothing may be written any more. */
  private closing = false

  constructor(cmd: string, args: string[], opts: SpawnOptionsWithoutStdio, private handlers: Handlers) {
    this.proc = spawn(cmd, args, { ...opts, stdio: 'pipe' })
    createInterface({ input: this.proc.stdout }).on('line', (line) => this.onLine(line))
    this.proc.stderr.on('data', (d) => handlers.onStderr?.(String(d)))
    // EPIPE and friends after the agent died must not crash the main process.
    this.proc.stdin.on('error', (err) => handlers.onStderr?.(`stdin: ${err.message}`))
    this.proc.on('error', (err) => this.fail(err))
    this.proc.on('exit', (code) => this.fail(new Error(`Agent process exited with code ${code}`), code))
  }

  private fail(err: Error, code: number | null = null): void {
    if (this.exited) return
    this.exited = true
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
    this.handlers.onExit(code)
  }

  private write(msg: Record<string, unknown>): void {
    if (this.exited || this.closing || !this.proc.stdin.writable) return
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  }

  private onLine(line: string): void {
    let msg: { id?: Id; method?: string; params?: unknown; result?: unknown; error?: { message: string; code?: number; data?: unknown } }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.method && msg.id != null) {
      const id = msg.id
      this.handlers
        .onRequest({ id, method: msg.method, params: msg.params })
        .then((result) => this.write({ id, result }))
        .catch((err: unknown) => {
          const e = err instanceof RpcError ? err : new RpcError(err instanceof Error ? err.message : String(err), -32603)
          this.write({ id, error: { code: e.code ?? -32603, message: e.message } })
        })
    } else if (msg.method) {
      this.handlers.onNotification(msg.method, msg.params)
    } else if (msg.id != null) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new RpcError(msg.error.message, msg.error.code, msg.error.data))
      else p.resolve(msg.result)
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.exited || this.closing) return Promise.reject(new Error('Agent process is not running'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) })
  }

  kill(): void {
    if (this.exited || this.closing) return
    this.closing = true
    this.proc.stdin.end()
    this.proc.kill()
  }
}
