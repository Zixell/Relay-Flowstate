import { describe, expect, it } from 'vitest'
import { toQuestions } from './claude-chat'

describe('toQuestions', () => {
  it('reads AskUserQuestion input', () => {
    expect(
      toQuestions({
        questions: [
          {
            question: 'Which approach?',
            header: 'Approach',
            multiSelect: false,
            options: [
              { label: 'Rewrite', description: 'Start over' },
              { label: 'Patch', description: 'Fix in place' }
            ]
          }
        ]
      })
    ).toEqual([
      {
        question: 'Which approach?',
        header: 'Approach',
        multiSelect: false,
        options: [
          { label: 'Rewrite', description: 'Start over' },
          { label: 'Patch', description: 'Fix in place' }
        ]
      }
    ])
  })

  it('ignores input that is not a question set', () => {
    expect(toQuestions({ command: 'ls' })).toBeUndefined()
    expect(toQuestions({ questions: [{ header: 'no text' }] })).toBeUndefined()
  })
})
