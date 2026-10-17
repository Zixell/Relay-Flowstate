import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { getGitChanges, getFileDiff } from './index'

describe('getGitChanges', () => {
  it('counts new untracked files, one by one inside new directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-changes-'))
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    execSync('git add -A && git commit -qm init', { cwd: dir })

    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'new.ts'), 'export const x = 1\nexport const y = 2\n')

    const files = getGitChanges(dir).files
    expect(files).toContainEqual({ path: 'a.txt', type: 'modified', additions: 1, deletions: 0 })
    expect(files).toContainEqual({ path: 'src/new.ts', type: 'added', additions: 2, deletions: 0 })
    expect(getFileDiff(dir, 'src/new.ts')).toContain('+export const y = 2')
  })
})
