import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { scorePath, suggestFiles } from './files'

describe('file suggestions for @ mentions', () => {
  it('requires the query characters in order', () => {
    expect(scorePath('src/main/index.ts', 'smi')).toBeGreaterThan(-1)
    expect(scorePath('src/main/index.ts', 'zz')).toBe(-1)
  })

  it('prefers file-name matches over directory matches', () => {
    const ranked = ['src/composer/util.ts', 'src/chat/Composer.tsx'].sort((a, b) => scorePath(b, 'compo') - scorePath(a, 'compo'))
    expect(ranked[0]).toBe('src/chat/Composer.tsx')
  })

  it('lists tracked and new files but not ignored ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-files-'))
    execSync('git init -q', { cwd: dir })
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'app.ts'), '')
    writeFileSync(join(dir, 'notes.md'), '')
    writeFileSync(join(dir, '.gitignore'), 'secret.env\n')
    writeFileSync(join(dir, 'secret.env'), '')
    execSync('git add src/app.ts', { cwd: dir })
    expect(suggestFiles(dir, '')).toEqual(expect.arrayContaining(['src/app.ts', 'notes.md', '.gitignore']))
    expect(suggestFiles(dir, '')).not.toContain('secret.env')
    expect(suggestFiles(dir, 'app')[0]).toBe('src/app.ts')
  })
})
