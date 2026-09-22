import { expect, it } from 'vitest'

import { parseSolver } from '../src/gridkit/solver.js'
import { within } from '../src/launch.js'
import { GRIDKIT_IMAGE } from '../src/runtime.js'
const valid = { system_model_file: 'case.case.json', tmax: 10, events: [] }
it('uses only the official latest image', () => {
  expect(GRIDKIT_IMAGE).toBe('ghcr.io/lukelowry/gridkit:latest')
})
it('accepts native solver options without renaming or dropping future options', () => {
  const input = {
    ...valid,
    dt_monitor: 0.01,
    consistent_ic_type: 'y',
    error_tolerance: [1e-4, 1e-5],
    future_option: 2,
  }
  expect(parseSolver(input)).toBe(input)
})
it('rejects invalid execution inputs and unordered or out-of-range events', () => {
  for (const patch of [
    { tmax: 0 },
    { tmax: Infinity },
    { events: null },
    { dt_monitor: -1 },
    { max_steps: 0.5 },
    { consistent_ic_type: 'bad' },
    { events: [{ time: 11, type: 'fault_on', element_id: 0 }] },
    {
      events: [
        { time: 2, type: 'fault_on', element_id: 0 },
        { time: 1, type: 'fault_off', element_id: 0 },
      ],
    },
  ]) {
    expect(() => parseSolver({ ...valid, ...patch })).toThrow()
  }
})
it('does not confuse a neighboring workspace prefix with containment', () => {
  expect(within('/work/case', '/work/case/solver.json')).toBe(true)
  expect(within('/work/case', '/work/case-other/solver.json')).toBe(false)
})

it('accepts native tolerance, order, and unlimited step modes', () => {
  for (const patch of [
    { rel_tol: 0, abs_tol: 1e-8 },
    { abs_tol: 0 },
    { max_steps: -1 },
    { max_steps: 0 },
    { max_order: 1 },
    { max_order: 5 },
  ])
    expect(() => parseSolver({ ...valid, ...patch })).not.toThrow()
})
it('rejects invalid orders, coerced enums, zero comparison tolerances, and unsafe step limits', () => {
  for (const patch of [
    { max_order: 0 },
    { max_order: 6 },
    { max_order: 1.5 },
    { max_order: '2' },
    { max_steps: Number.MAX_SAFE_INTEGER + 1 },
    { rel_tol: 0, abs_tol: 0 },
    { error_tolerance: [1e-4, 0] },
    { consistent_ic_type: ['y'] },
    { error_type: ['absolute'] },
  ])
    expect(() => parseSolver({ ...valid, ...patch })).toThrow()
})
