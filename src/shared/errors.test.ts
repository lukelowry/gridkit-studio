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

describe('errors', () => {
  it('shows the user an error message, and only a generic message for a defect', () => {
    expect(message(new Error('Choose a numeric field to map.'))).toBe(
      'Choose a numeric field to map.',
    )
    expect(message('Plain text.')).toBe('Plain text.')
    const read = new TypeError("Cannot read properties of undefined (reading 'fields')")
    expect(defect(read)).toBe(true)
    expect(message(read)).toBe(UNEXPECTED)
    // An error from the worker carries its defect flag and detail.
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

  it('distinguishes cancellations and quiet failures from real failures', () => {
    expect(cancelled(new DOMException('Cancelled', 'AbortError'))).toBe(true)
    expect(cancelled(Object.assign(new Error('Canceled'), { name: 'Canceled' }))).toBe(true)
    expect(cancelled(new Error('Cancelled'))).toBe(false)
    expect(cancelled(undefined)).toBe(false)
    for (const code of ['superseded', 'results-closed', 'cancelled', 'results-lost'] as const)
      expect(quiet(problem(code, 'Nothing failed.'))).toBe(true)
    expect(quiet(problem('invalid-input', 'Read the case again.'))).toBe(false)
  })

  it('keeps an error code and its details across a channel', () => {
    const range = { start: [4, 0], end: [4, 2] }
    const made = problem('invalid-input', 'Read the case again.', { range })
    expect(failedWith(made, 'invalid-input')).toBe(true)
    const crossed = errorOf(problemOf(made))
    expect(crossed).toMatchObject({ message: 'Read the case again.', code: 'invalid-input', range })
    expect(problemOf(new Error('No code.')).code).toBe('operation-failed')
    expect(errorOf(problemOf(new DOMException('Gone', 'AbortError')))).toMatchObject({
      name: 'AbortError',
    })
  })
})
