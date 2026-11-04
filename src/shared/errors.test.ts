import { describe, expect, it } from 'vitest'

import {
  cancelled,
  defect,
  detail,
  errorOf,
  failedWith,
  message,
  problem,
  problemOf,
  quiet,
  UNEXPECTED,
} from './errors.js'

describe('errors for people and for the log', () => {
  it('tells the user a sentence, and a defect only that it happened', () => {
    expect(message(new Error('Choose a numeric field to map.'))).toBe(
      'Choose a numeric field to map.',
    )
    expect(message('Plain text.')).toBe('Plain text.')
    const read = new TypeError("Cannot read properties of undefined (reading 'fields')")
    expect(defect(read)).toBe(true)
    expect(message(read)).toBe(UNEXPECTED)
    // An error that crossed from the worker says what it was.
    const crossed = Object.assign(new Error(UNEXPECTED), { defect: true, detail: 'TypeError: x' })
    expect(defect(crossed)).toBe(true)
    expect(detail(crossed)).toBe('TypeError: x')
  })

  it('logs the stack an error was thrown with', () => {
    const error = new Error('Disk full.')
    expect(detail(error)).toContain('Disk full.')
    expect(detail(error)).toContain('errors.test.ts')
    expect(detail('As text.')).toBe('As text.')
  })

  it('knows a cancellation, and the failures that are none, from a failure', () => {
    expect(cancelled(new DOMException('Cancelled', 'AbortError'))).toBe(true)
    expect(cancelled(Object.assign(new Error('Canceled'), { name: 'Canceled' }))).toBe(true)
    expect(cancelled(new Error('Cancelled'))).toBe(false)
    expect(cancelled(undefined)).toBe(false)
    for (const code of ['superseded', 'results-closed', 'cancelled', 'results-lost'] as const)
      expect(quiet(problem(code, 'Nothing failed.'))).toBe(true)
    expect(quiet(problem('case-changed', 'Read the case again.'))).toBe(false)
  })

  it('keeps a code, and what comes with it, across a channel', () => {
    const range = { start: [4, 0], end: [4, 2] }
    const made = problem('case-changed', 'Read the case again.', { range })
    expect(failedWith(made, 'case-changed')).toBe(true)
    const crossed = errorOf(problemOf(made))
    expect(crossed).toMatchObject({ message: 'Read the case again.', code: 'case-changed', range })
    expect(problemOf(new Error('No code.')).code).toBe('operation-failed')
    expect(errorOf(problemOf(new DOMException('Gone', 'AbortError')))).toMatchObject({
      name: 'AbortError',
    })
  })
})
