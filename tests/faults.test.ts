import { readFileSync } from 'node:fs'

import { expect, it } from 'vitest'

import { validate } from '../src/gridkit/validate.js'
import {
  appendFault,
  faultDefaults,
  faultDevices,
  faultIntervals,
  planFault,
  validateFault,
} from '../src/simulation/faults.js'
const text = readFileSync('tests/fixtures/solver/two-bus.case.json', 'utf8')
it('appends real-valued impedance without rewriting existing parameters and uses the fault ordinal', () => {
  const raw = validate(JSON.parse(text))
  const result = appendFault(text, raw, raw.buses[0].number, 0, 1)
  expect(result.index).toBe(faultDevices(raw).length)
  expect(result.text).toMatch(/"R": 0\.0/)
  expect(result.text).toMatch(/"X": 1\.0/)
  const parsed = JSON.parse(result.text)
  expect(parsed.devices.slice(0, -1)).toEqual(raw.devices)
  expect(faultDevices(validate(parsed)).at(-1)?.device.id).toBe('fault_1')
})
it('groups only unambiguous intervals and preserves unpaired transitions', () => {
  const raw = validate(JSON.parse(text))
  const events = [
    { time: 1, type: 'fault_on', element_id: 0 },
    { time: 2, type: 'fault_off', element_id: 0 },
    { time: 3, type: 'fault_on', element_id: 0 },
  ]
  expect(faultIntervals(events, raw)).toEqual([{ device: 0, on: 0, off: 1, start: 1, duration: 1 }])
  expect(faultIntervals([events[0], events[0], events[1]], raw)).toEqual([])
})
it('rejects an absent bus or zero impedance before producing an edit', () => {
  const raw = validate(JSON.parse(text))
  expect(() => appendFault(text, raw, -100, 0, 1)).toThrow('bus')
  expect(() => appendFault(text, raw, raw.buses[0].number, 0, 0)).toThrow('impedance')
})

it('reuses an inactive matching device and rejects overlapping intervals at its bus', () => {
  const raw = validate(JSON.parse(text))
  const fault = { bus: 0, start: 1, duration: 0.15, resistance: 0, reactance: 0.001 }
  const first = planFault(text, raw, [], fault)
  expect(first.text).toBe(text)
  expect(first.events.map((event) => event.element_id)).toEqual([0, 0])
  expect(() => planFault(text, raw, first.events, { ...fault, start: 1.1 })).toThrow(
    'already has a fault',
  )
  const second = planFault(text, raw, first.events, { ...fault, start: 2 })
  expect(second.text).toBe(text)
  expect(second.events).toHaveLength(4)
})
it('changing one interval impedance leaves other intervals on the original device', () => {
  const raw = validate(JSON.parse(text))
  const fault = { bus: 0, start: 1, duration: 0.1, resistance: 0, reactance: 0.001 }
  const first = planFault(text, raw, [], fault)
  const second = planFault(text, raw, first.events, { ...fault, start: 2 })
  const edited = planFault(
    text,
    raw,
    second.events,
    { ...fault, reactance: 1 },
    faultIntervals(second.events, raw)[0],
  )
  expect(edited.events.map((event) => event.element_id)).toEqual([1, 1, 0, 0])
  expect(JSON.parse(edited.text).devices.at(-2).params.X).toBe(0.001)
  expect(edited.text).toMatch(/"X": 1\.0/)
})
it('validates the complete interval and impedance together', () => {
  expect(
    validateFault({ bus: 1, start: 1, duration: 2, resistance: 0, reactance: 0 }, 2),
  ).toMatchObject({ duration: expect.any(String), reactance: expect.any(String) })
})

it.each([0.1, 1, 10])('seeds valid faults inside a %s-second run from the timeline', (tmax) => {
  for (const time of [0, tmax / 2, tmax, tmax + 1]) {
    const value = faultDefaults(0, time, tmax)
    expect(validateFault(value, tmax)).toEqual({})
    expect(value.start).toBeLessThanOrEqual(Math.min(time, tmax))
    expect(value.start + value.duration).toBeLessThanOrEqual(tmax)
  }
})
