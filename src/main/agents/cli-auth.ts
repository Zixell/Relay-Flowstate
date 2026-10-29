import { spawn } from 'child_process'
import { dirname, delimiter } from 'path'
import type { IPty } from 'node-pty'
import { resolveExecutable } from './resolve-executable'

/** Helpers for driving an agent CLI's own sign-in commands. */

let pty: typeof import('node-pty') | null = null
try {
  pty = require('node-pty')
} catch {
  // the sign-in that needs a terminal reports it
}

/** Environment for an installed CLI: npm-installed ones are node scripts, and a GUI app's PATH may not contain node. */
export function cliEnv(executable: string): Record<string, string> {
  return { ...process.env, PATH: `${dirname(executable)}${delimiter}${process.env.PATH ?? ''}` } as Record<string, string>
}

/** Windows runs .cmd/.bat shims (npm-installed CLIs) only through cmd.exe. */
export function viaShim(executable: string, args: string[]): { file: string; args: string[] } {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', executable, ...args] }
    : { file: executable, args }
}

export function requireExecutable(binary: string): string {
  const executable = resolveExecutable(binary)
  if (!executable) throw new Error(`${binary} not found. Install it and make sure it is on your PATH.`)
  return executable
}

/** Runs a CLI to completion. Never rejects on a non-zero exit — callers read `code`. */
export function runCli(
  binary: string,
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const executable = requireExecutable(binary)
  const cmd = viaShim(executable, args)
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd.file, cmd.args, { env: cliEnv(executable), windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 20_000)
    proc.stdout.on('data', (d) => (stdout += d))
    proc.stderr.on('data', (d) => (stderr += d))
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    proc.stdin.on('error', () => {})
    proc.stdin.end(opts.input ?? '')
  })
}

/**
 * Starts a CLI in a pseudo-terminal, for interactive sign-in prompts that
 * refuse to run without one. Very wide, so printed URLs never wrap.
 */
export function spawnInPty(binary: string, args: string[]): IPty {
  if (!pty) throw new Error('Signing in needs node-pty, which is not built in this copy of the app.')
  const executable = requireExecutable(binary)
  const cmd = viaShim(executable, args)
  return pty.spawn(cmd.file, cmd.args, {
    name: 'xterm-256color',
    cols: 4000,
    rows: 50,
    cwd: process.env.HOME || process.env.USERPROFILE || process.cwd(),
    env: { ...cliEnv(executable), TERM: 'xterm-256color' }
  })
}

/** Terminal output as plain text: escape sequences and carriage returns removed. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78]/g, '')
    .replace(/\r/g, '')
}

/** The last line worth showing from a failed command's output. */
export function lastLine(text: string): string | undefined {
  return stripAnsi(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
}
