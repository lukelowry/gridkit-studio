import { changeJson, changeReal } from '../gridkit/edit.js'
import type { SolverInput } from '../gridkit/solver.js'
import type { Case, Device } from '../gridkit/validate.js'

export type FaultEvent = SolverInput['events'][number]
export interface FaultInterval {
  device: number
  on: number
  off: number
  start: number
  duration: number
}
export interface FaultDevice {
  device: Device
  index: number
  position: number
}
export function faultDevices(raw: Case): FaultDevice[] {
  const result: FaultDevice[] = []
  raw.devices.forEach((device, position) => {
    if (device.class === 'BusFault') result.push({ device, position, index: result.length })
  })
  return result
}
/** Only group clean alternating transitions; ambiguous imported sequences stay individual. */
export function faultIntervals(events: readonly FaultEvent[], raw: Case): FaultInterval[] {
  return faultDevices(raw).flatMap(({ device, index }) => {
    const transitions = events.flatMap((event, at) =>
      event.element_id === index ? [{ event, at }] : [],
    )
    let active = device.params.state0 === true
    let on: (typeof transitions)[number] | undefined
    const result: FaultInterval[] = []
    for (const transition of transitions) {
      const applying = transition.event.type.toLowerCase() === 'fault_on'
      if (applying === active) return []
      active = applying
      if (applying) on = transition
      else if (on) {
        result.push({
          device: index,
          on: on.at,
          off: transition.at,
          start: on.event.time,
          duration: transition.event.time - on.event.time,
        })
        on = undefined
      }
    }
    return result
  })
}
export function faultLabel(raw: Case, index: number): string {
  const fault = faultDevices(raw)[index]?.device
  if (!fault) return `Missing fault ${index}`
  const bus = raw.buses.find((bus) => bus.number === fault.ports.bus)
  return `Bus ${fault.ports.bus}${bus?.name ? ` · ${bus.name}` : ''}`
}
export function appendFault(
  text: string,
  raw: Case,
  bus: number,
  resistance: number,
  reactance: number,
): { text: string; index: number } {
  if (!raw.buses.some((value) => value.number === bus)) throw new Error('The bus no longer exists.')
  if (
    ![resistance, reactance].every((value) => Number.isFinite(value) && value >= 0) ||
    resistance + reactance === 0
  )
    throw new Error('Use nonnegative impedance with a nonzero resistance or reactance.')
  const faults = faultDevices(raw)
  const ids = new Set(faults.map((fault) => fault.device.id))
  let id = 1
  while (ids.has(`fault_${id}`)) id++
  const path = ['devices', raw.devices.length]
  let next = changeJson(text, path, {
    class: 'BusFault',
    id: `fault_${id}`,
    ports: { bus },
    params: { state0: false, R: resistance, X: reactance },
  })
  next = changeReal(next, [...path, 'params', 'R'], resistance)
  next = changeReal(next, [...path, 'params', 'X'], reactance)
  return { text: next, index: faults.length }
}

export interface FaultInput {
  bus: number
  start: number
  duration: number
  resistance: number
  reactance: number
}
/** Keep a new interval within the run, including when the timeline is at its end. */
export function faultDefaults(bus: number, time: number, tmax: number): FaultInput {
  const duration = Math.min(0.15, tmax / 2)
  const start = Math.min(Math.max(Number.isFinite(time) ? time : 0, 0), tmax - duration)
  return { bus, start, duration: Math.min(duration, tmax - start), resistance: 0, reactance: 0.01 }
}
export type FaultErrors = Partial<Record<keyof FaultInput, string>>
export function validateFault(value: FaultInput, tmax: number): FaultErrors {
  const errors: FaultErrors = {}
  if (!Number.isSafeInteger(value.bus)) errors.bus = 'Choose a bus.'
  if (!Number.isFinite(value.start) || value.start < 0 || value.start >= tmax)
    errors.start = `Start must be from 0 to less than ${tmax} s.`
  if (!Number.isFinite(value.duration) || value.duration <= 0)
    errors.duration = 'Duration must be greater than zero.'
  else if (value.start + value.duration > tmax)
    errors.duration = `The fault must clear by ${tmax} s.`
  for (const key of ['resistance', 'reactance'] as const)
    if (!Number.isFinite(value[key]) || value[key] < 0) errors[key] = 'Enter a nonnegative number.'
  if (value.resistance === 0 && value.reactance === 0)
    errors.reactance = 'Resistance and reactance cannot both be zero.'
  return errors
}
/** Resolve one interval without changing the impedance of other scheduled intervals. */
export function planFault(
  text: string,
  raw: Case,
  events: readonly FaultEvent[],
  value: FaultInput,
  interval?: FaultInterval,
): { text: string; events: FaultEvent[] } {
  if (!raw.buses.some((bus) => bus.number === value.bus))
    throw new Error('The bus no longer exists.')
  const remaining = events.filter((_, i) => i !== interval?.on && i !== interval?.off)
  const devices = faultDevices(raw)
  const matching = devices.filter(
    ({ device }) =>
      device.ports.bus === value.bus &&
      device.params.state0 === false &&
      device.params.R === value.resistance &&
      device.params.X === value.reactance &&
      device.ports.control_signal === undefined,
  )
  const intervals = faultIntervals(remaining, raw)
  // A second overlapping interval at this bus is usually an accidental duplicate, not a second device.
  if (
    intervals.some(
      (other) =>
        devices[other.device].device.ports.bus === value.bus &&
        other.start < value.start + value.duration &&
        value.start < other.start + other.duration,
    )
  )
    throw new Error(
      'This bus already has a fault during that interval. Edit it or choose a different time.',
    )
  const compatible = matching.find((candidate) => {
    const transitions = remaining.filter((event) => event.element_id === candidate.index)
    return (
      transitions.length ===
      intervals.filter((other) => other.device === candidate.index).length * 2
    )
  })
  const placed = compatible
    ? { text, index: compatible.index }
    : appendFault(text, raw, value.bus, value.resistance, value.reactance)
  return {
    text: placed.text,
    events: [
      ...remaining,
      { time: value.start, type: 'fault_on', element_id: placed.index },
      { time: value.start + value.duration, type: 'fault_off', element_id: placed.index },
    ].sort((a, b) => a.time - b.time),
  }
}
