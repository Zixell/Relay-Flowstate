import { describe, expect, it } from 'vitest'
import { execSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentEvent } from '../agents/adapter'
import { captureTree, changedBetween, pathsTouchedBy } from './tree'

const dir = (): string => mkdtempSync(join(tmpdir(), 'relay-tree-'))

describe('tree', () => {
  it('tells changed files outside git by size and modification time', () => {
    const d = dir()
    writeFileSync(join(d, 'hello.txt'), 'hello\n')
    writeFileSync(join(d, 'gone.txt'), 'x')
    mkdirSync(join(d, 'node_modules'))
    writeFileSync(join(d, 'node_modules', 'dep.js'), '1')
    const before = captureTree(d, 't', 'b')
    expect(before?.kind).toBe('scan')

    writeFileSync(join(d, 'hello.txt'), 'hello\ntest\n')
    rmSync(join(d, 'gone.txt'))
    mkdirSync(join(d, 'src'))
    writeFileSync(join(d, 'src', 'new.ts'), 'export {}')
    writeFileSync(join(d, 'node_modules', 'dep.js'), '22')
    expect(changedBetween(d, before, captureTree(d, 't', 'a'))).toEqual(['gone.txt', 'hello.txt', join('src', 'new.ts')])
  })

  it('sees a rewrite of the same size through the modification time', () => {
    const d = dir()
    writeFileSync(join(d, 'a.txt'), 'aaa')
    utimesSync(join(d, 'a.txt'), new Date(1000), new Date(1000))
    const before = captureTree(d, 't', 'b')
    writeFileSync(join(d, 'a.txt'), 'bbb')
    expect(changedBetween(d, before, captureTree(d, 't', 'a'))).toEqual(['a.txt'])
  })

  it('uses git snapshots in a repository', () => {
    const d = dir()
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: d })
    writeFileSync(join(d, 'a.txt'), 'one\n')
    execSync('git add -A && git commit -qm init', { cwd: d })
    const before = captureTree(d, 't', 'b')
    expect(before?.kind).toBe('git')
    writeFileSync(join(d, 'a.txt'), 'two\n')
    expect(changedBetween(d, before, captureTree(d, 't', 'a'))).toEqual(['a.txt'])
  })

  it('reads the files a finished edit reports', () => {
    const e: AgentEvent = { type: 'tool.completed', toolCallId: 'x', status: 'ok', diff: [{ path: '/repo/src/a.ts' }, { path: 'b.ts' }] }
    expect(pathsTouchedBy(e, '/repo')).toEqual([join('src', 'a.ts'), 'b.ts'])
    expect(pathsTouchedBy({ ...e, status: 'error' } as AgentEvent, '/repo')).toEqual([])
  })
})
