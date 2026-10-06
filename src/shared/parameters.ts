/** The next run's parameters: parse, show and check what is entered, and which of them count. */

import type { InputValue, Parameter } from '@latkit/model'

import { formatNumber } from './format.js'
import type { Program } from './simulation.js'

/** Entered values by parameter name; a missing one takes its default. */
export type Values = Readonly<Record<string, InputValue>>
export type Entry = readonly [name: string, parameter: Parameter]

export const labelOf = (name: string, parameter: Parameter): string => parameter.label ?? name

/** `text` parsed for `parameter`; undefined when blank. Text that is not a number stays as typed,
 *  so the extension, which hears values as JSON, says it is not a number rather than missing. */
export function valueOf(parameter: Parameter, text: string): InputValue | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (parameter.type !== 'number') return trimmed
  const number = Number(trimmed)
  return Number.isFinite(number) ? number : trimmed
}

/** The text a field shows for `value`. */
export function textOf(value: InputValue | undefined): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'number' ? formatNumber(value) : String(value)
}

/** The value of `name` as entered, else its parameter's default. */
export const enteredOf = (
  values: Values,
  name: string,
  parameter: Parameter,
): InputValue | undefined =>
  Object.hasOwn(values, name)
    ? values[name]
    : 'default' in parameter
      ? parameter.default
      : undefined

/** Why `value` cannot run, as a sentence naming it by `label`, which Start's notification says;
 *  null when it can. Exclusive bounds and rules across parameters are left to the worker. */
export function problemOf(
  parameter: Parameter,
  label: string,
  value: InputValue | undefined,
): string | null {
  if (value === undefined || value === null)
    return parameter.optional === true ? null : `${label} is required.`
  if (parameter.type !== 'number') return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} must be a number.`
  if (parameter.integer === true && !Number.isSafeInteger(value))
    return `${label} must be a whole number.`
  if (parameter.min !== undefined && value < parameter.min)
    return `${label} must be at least ${formatNumber(parameter.min)}.`
  if (parameter.max !== undefined && value > parameter.max)
    return `${label} must be at most ${formatNumber(parameter.max)}.`
  return null
}

/** The run form for `values`: the program, a simulation's fault switch and its bus, the fault's
 *  timing and impedance (a simulation's while its fault is on, an analysis's always), the other
 *  parameters, and every one of them that counts toward the next run. */
export function formOf(parameters: Readonly<Record<string, Parameter>>, values: Values) {
  const program = (values.program ?? 'DynamicSimulation') as Program
  const simulation = program === 'DynamicSimulation'
  const faulted = values.fault === true
  const entries = Object.entries(parameters).filter(([name]) => name !== 'program')
  const toggle = simulation ? entries.find(([name]) => name === 'fault') : undefined
  const bus = simulation ? entries.find(([name]) => name === 'fault_bus') : undefined
  const fault = entries.filter(
    ([name]) => name.startsWith('fault_') && name !== 'fault_bus' && (!simulation || faulted),
  )
  const others = entries.filter(([name]) => name !== 'fault' && !name.startsWith('fault_'))
  const counted: Entry[] = [
    ...(toggle ? [toggle] : []),
    ...(bus && faulted ? [bus] : []),
    ...fault,
    ...others,
  ]
  return { program, faulted, toggle, bus, fault, others, counted }
}

/** Why each parameter that counts cannot run, by name. */
export function problemsOf(
  parameters: Readonly<Record<string, Parameter>>,
  values: Values,
): Record<string, string> {
  const found: Record<string, string> = {}
  for (const [name, parameter] of formOf(parameters, values).counted) {
    const problem = problemOf(
      parameter,
      labelOf(name, parameter),
      enteredOf(values, name, parameter),
    )
    if (problem !== null) found[name] = problem
  }
  return found
}
