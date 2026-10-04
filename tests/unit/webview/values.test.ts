import type { Parameter } from '@latkit/model'
import { describe, expect, it } from 'vitest'

import { problemOf, textOf, valueOf } from '../../../src/webview/simulation/values.js'

const duration: Parameter = { label: 'Duration', type: 'number', min: 0.5, max: 60 }
const steps: Parameter = { label: 'Steps', type: 'number', integer: true, multiple: true }
const method: Parameter = { label: 'Method', type: 'choice', choices: ['fast'] }

describe('form values', () => {
  it('reads what is typed: numbers, lists, and the rest as text', () => {
    expect(valueOf(duration, ' 2.5 ')).toBe(2.5)
    expect(valueOf(duration, '')).toBeUndefined()
    expect(valueOf(steps, '1, 2 3')).toEqual([1, 2, 3])
    expect(valueOf(method, 'fast')).toBe('fast')
    expect(Number.isNaN(valueOf(duration, 'soon'))).toBe(true)
  })

  it('writes a value back as text', () => {
    expect(textOf(2.5)).toBe('2.5')
    expect(textOf([1, 2])).toBe('1, 2')
    expect(textOf(undefined)).toBe('')
    expect(textOf(new File([], 'results.csv'))).toBe('results.csv')
  })

  it('catches what can never run, bounds included, and leaves the rest to the model', () => {
    expect(problemOf(duration, 'Duration', undefined)).toBe('Duration is required.')
    expect(problemOf({ ...duration, optional: true }, 'Duration', undefined)).toBeNull()
    expect(problemOf(duration, 'Duration', Number.NaN)).toBe('Enter a number.')
    expect(problemOf(duration, 'Duration', 0.4)).toBe('Enter a number at least 0.5.')
    expect(problemOf(duration, 'Duration', 0.5)).toBeNull()
    expect(problemOf(duration, 'Duration', 60)).toBeNull()
    expect(problemOf(duration, 'Duration', 61)).toBe('Enter a number at most 60.')
    expect(problemOf(steps, 'Steps', [1, 2.5])).toBe('Enter a whole number.')
    expect(problemOf(method, 'Method', 'slow')).toBeNull()
  })
})
