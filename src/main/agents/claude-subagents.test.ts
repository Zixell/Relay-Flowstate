import { describe, expect, it } from 'vitest'
import { handbackReport, isHandbackPointer, isInterimAgentNotice } from './claude-chat'

describe('subagent reports', () => {
  it('takes the report out of a hand-back frame', () => {
    const body = [
      '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user.',
      'The harness indents every line of the report. The report follows:',
      '  I ran the count.',
      '  ',
      '  | Folder | Lines |',
      '  |---|---|',
      '  | src/main | 9392 |'
    ].join('\n')
    expect(handbackReport(body)).toBe('I ran the count.\n\n| Folder | Lines |\n|---|---|\n| src/main | 9392 |')
  })

  it('keeps a body without the frame as is', () => {
    expect(handbackReport('Done: 3 files.')).toBe('Done: 3 files.')
  })

  it('tells interim and pointer notices from a real summary', () => {
    const interim = 'This agent has not reported yet: it is waiting on its own background work and will deliver its report through SubagentHandback when that finishes.'
    const pointer = 'This agent\'s report was delivered to you as a message from "ae62dedf68ddcdb7b" (its SubagentHandback call). Read it there; it is not repeated here.'
    expect(isInterimAgentNotice(interim)).toBe(true)
    expect(isHandbackPointer(pointer)).toBe(true)
    expect(isInterimAgentNotice('16')).toBe(false)
    expect(isHandbackPointer('16')).toBe(false)
  })
})
