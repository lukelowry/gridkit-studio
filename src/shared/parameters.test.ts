import type { Parameter } from '@latkit/model'
import { describe, expect, it } from 'vitest'

import { formOf, problemOf, problemsOf, textOf, valueOf } from './parameters.js'

const duration: Parameter = { label: 'Duration', type: 'number', min: 0.5, max: 60 }
const steps: Parameter = { label: 'Steps', type: 'number', integer: true }
const method: Parameter = { label: 'Method', type: 'choice', choices: ['fast'] }

describe('run parameters', () => {
  it('reads what is typed: numbers, and the rest as text', () => {
    expect(valueOf(duration, ' 2.5 ')).toBe(2.5)
    expect(valueOf(duration, '')).toBeUndefined()
    expect(valueOf(method, 'fast')).toBe('fast')
    // Not a number: kept as typed, which the checks then call not a number.
    expect(valueOf(duration, 'soon')).toBe('soon')
    expect(problemOf(duration, 'Duration', valueOf(duration, 'soon'))).toBe(
      'Duration must be a number.',
    )
  })

  it('writes a value back as text', () => {
    expect(textOf(2.5)).toBe('2.5')
    expect(textOf('fast')).toBe('fast')
    expect(textOf(undefined)).toBe('')
  })

  it('catches what can never run, bounds included, and leaves the rest to the model', () => {
    expect(problemOf(duration, 'Duration', undefined)).toBe('Duration is required.')
    expect(problemOf({ ...duration, optional: true }, 'Duration', undefined)).toBeNull()
    expect(problemOf(duration, 'Duration', Number.NaN)).toBe('Duration must be a number.')
    expect(problemOf(duration, 'Duration', 0.4)).toBe('Duration must be at least 0.5.')
    expect(problemOf(duration, 'Duration', 0.5)).toBeNull()
    expect(problemOf(duration, 'Duration', 60)).toBeNull()
    expect(problemOf(duration, 'Duration', 61)).toBe('Duration must be at most 60.')
    expect(problemOf(steps, 'Steps', 2.5)).toBe('Steps must be a whole number.')
    expect(problemOf(method, 'Method', 'slow')).toBeNull()
  })

  it("counts a simulation's fault only while it is on, and an analysis's always", () => {
    const parameters: Record<string, Parameter> = {
      tmax: { label: 'End time', type: 'number', min: 0 },
      fault: { label: 'Fault', type: 'boolean', default: false },
      fault_bus: { label: 'Bus', type: 'reference', to: 'Bus' },
      fault_start: { label: 'Start', type: 'number', default: 1 },
    }
    const names = (values: Record<string, unknown>) =>
      formOf(parameters, values as never).counted.map(([name]) => name)
    expect(names({})).toEqual(['fault', 'tmax'])
    expect(names({ fault: true })).toEqual(['fault', 'fault_bus', 'fault_start', 'tmax'])
    expect(names({ program: 'ContingencyAnalysis' })).toEqual(['fault_start', 'tmax'])
    // What cannot run stops the run; a default fills what was never entered.
    expect(problemsOf(parameters, {})).toEqual({ tmax: 'End time is required.' })
    expect(problemsOf(parameters, { tmax: 2, fault: true })).toEqual({
      fault_bus: 'Bus is required.',
    })
    expect(problemsOf(parameters, { tmax: 2 })).toEqual({})
  })
})
