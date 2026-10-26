import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory stand-ins for the task table and settings
const tasks = new Map<string, { id: string; metadata: string | null }>()
const settings = new Map<string, string>()
const sent: { taskId: string; metadata: string }[] = []

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (_: string, p: { taskId: string; metadata: string }) => sent.push(p) } }] },
  powerMonitor: { on: () => {} }
}))
vi.mock('../db', () => ({
  getAllTasks: () => [...tasks.values()],
  getTaskById: (id: string) => tasks.get(id) ?? null,
  updateTaskMetadata: (id: string, meta: Record<string, unknown>) => {
    const t = tasks.get(id)
    if (t) t.metadata = JSON.stringify(meta)
  }
}))
vi.mock('../settings', () => ({ getSetting: (key: string) => settings.get(key) ?? '' }))

const resumeAt = (id: string): unknown => JSON.parse(tasks.get(id)!.metadata ?? '{}').resumeAt

describe('auto-resume', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(0)
    tasks.clear()
    settings.clear()
    sent.length = 0
    for (const id of ['a', 'b', 'c']) tasks.set(id, { id, metadata: JSON.stringify({ startCommit: 'x' }) })
  })
  afterEach(() => vi.useRealTimers())

  it('continues each task a minute after its reset, earliest first and one at a time', async () => {
    const { initAutoResume, scheduleResume } = await import('./auto-resume')
    const resumed: string[] = []
    initAutoResume(async (id) => void resumed.push(id))

    scheduleResume('b', 120_000)
    scheduleResume('a', 60_000)
    expect(resumeAt('a')).toBe(120_000)
    expect(JSON.parse(tasks.get('a')!.metadata!).startCommit).toBe('x')
    expect(sent.at(-1)?.taskId).toBe('a')

    await vi.advanceTimersByTimeAsync(119_999)
    expect(resumed).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(resumed).toEqual(['a'])
    expect(resumeAt('a')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(resumed).toEqual(['a', 'b'])
  })

  it('spaces out tasks that are due together', async () => {
    const { initAutoResume, scheduleResume } = await import('./auto-resume')
    const resumed: [string, number][] = []
    initAutoResume(async (id) => void resumed.push([id, Date.now()]))
    scheduleResume('a', 0)
    scheduleResume('b', 0)
    await vi.advanceTimersByTimeAsync(70_000)
    expect(resumed).toEqual([
      ['a', 60_000],
      ['b', 65_000]
    ])
  })

  it('picks up saved continuations after a restart, overdue ones shortly after launch', async () => {
    tasks.get('c')!.metadata = JSON.stringify({ resumeAt: -5_000 })
    const { initAutoResume } = await import('./auto-resume')
    const resumed: string[] = []
    initAutoResume(async (id) => void resumed.push(id))
    await vi.advanceTimersByTimeAsync(9_999)
    expect(resumed).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(resumed).toEqual(['c'])
  })

  it('does nothing once cancelled or when the setting is off', async () => {
    const { initAutoResume, scheduleResume, cancelResume } = await import('./auto-resume')
    const resumed: string[] = []
    initAutoResume(async (id) => void resumed.push(id))

    scheduleResume('a', 0)
    cancelResume('a')
    expect(resumeAt('a')).toBeUndefined()

    settings.set('RELAY_AUTO_CONTINUE', 'false')
    scheduleResume('b', 0)
    expect(resumeAt('b')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(resumed).toEqual([])
  })
})
