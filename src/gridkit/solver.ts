import { record } from '../targets.js'

export interface SolverInput {
  system_model_file: string
  tmax: number
  dt_monitor?: number
  dt_fixed?: number
  rel_tol?: number
  abs_tol?: number
  max_steps?: number
  max_order?: number
  consistent_ic_type?: 'y' | 'ya_ydp'
  events: { time: number; type: string; element_id: number }[]
  output_file?: string
  reference_file?: string
  error_tolerance?: number | number[]
  error_type?: string
  abs_err_threshold?: number
}
export class SolverError extends Error {
  constructor(
    readonly path: readonly (string | number)[],
    message: string,
  ) {
    super(message)
  }
}
export function parseSolver(value: unknown): SolverInput {
  if (
    !record(value) ||
    typeof value.system_model_file !== 'string' ||
    !value.system_model_file.trim() ||
    !Array.isArray(value.events)
  )
    throw new SolverError([], 'A solver requires system_model_file and an events array.')
  const finite = (name: string, minimum: number, required = false) => {
    const number = value[name]
    if (number === undefined && !required) return
    if (typeof number !== 'number' || !Number.isFinite(number) || number < minimum)
      throw new SolverError(
        [name],
        `${name} must be a finite number greater than or equal to ${minimum}.`,
      )
  }
  finite('tmax', Number.MIN_VALUE, true)
  for (const name of ['dt_monitor', 'dt_fixed', 'abs_err_threshold', 'rel_tol', 'abs_tol'])
    finite(name, 0)
  if (value.max_steps !== undefined && !Number.isSafeInteger(value.max_steps))
    throw new SolverError(
      ['max_steps'],
      'max_steps must be a safe integer; use a negative value for unlimited steps.',
    )
  if (
    value.max_order !== undefined &&
    (typeof value.max_order !== 'number' ||
      !Number.isInteger(value.max_order) ||
      value.max_order < 1 ||
      value.max_order > 5)
  )
    throw new SolverError(['max_order'], 'max_order must be an integer from 1 to 5.')
  if ((value.rel_tol ?? 1e-7) === 0 && (value.abs_tol ?? 1e-9) === 0)
    throw new SolverError(['abs_tol'], 'Use a positive abs_tol when rel_tol is zero.')
  if (
    value.consistent_ic_type !== undefined &&
    (typeof value.consistent_ic_type !== 'string' ||
      !['y', 'ya_ydp'].includes(value.consistent_ic_type))
  )
    throw new SolverError(['consistent_ic_type'], 'consistent_ic_type must be y or ya_ydp.')
  let previous = 0
  for (const [index, event] of value.events.entries()) {
    if (
      !record(event) ||
      typeof event.time !== 'number' ||
      !Number.isFinite(event.time) ||
      event.time < previous ||
      event.time > (value.tmax as number) ||
      !Number.isSafeInteger(event.element_id) ||
      (event.element_id as number) < 0 ||
      typeof event.type !== 'string' ||
      !['fault_on', 'fault_off'].includes(event.type.toLowerCase())
    )
      throw new SolverError(
        ['events', index],
        'Events require ordered times within tmax, a nonnegative element_id, and fault_on or fault_off.',
      )
    previous = event.time
  }
  for (const name of ['output_file', 'reference_file'])
    if (
      value[name] !== undefined &&
      (typeof value[name] !== 'string' || !(value[name] as string).trim())
    )
      throw new SolverError([name], `${name} must be a nonempty file path.`)
  if (
    value.error_type !== undefined &&
    (typeof value.error_type !== 'string' ||
      !['relative', 'absolute'].includes(value.error_type.toLowerCase()))
  )
    throw new SolverError(['error_type'], 'error_type must be relative or absolute.')
  if (value.error_tolerance !== undefined) {
    const tolerances = Array.isArray(value.error_tolerance)
      ? value.error_tolerance
      : [value.error_tolerance]
    if (
      !tolerances.length ||
      tolerances.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n <= 0)
    )
      throw new SolverError(
        ['error_tolerance'],
        'error_tolerance must contain positive finite numbers.',
      )
  }
  return value as unknown as SolverInput
}

export type SolverOptions = Omit<SolverInput, 'system_model_file'>
