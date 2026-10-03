/** What a host's run asks for: the simulation its values describe, and the outputs it records.
 *  Latkit has already validated scalar arguments, field names and remote row shapes. */
import type {
  Arguments,
  Domain,
  FieldSelection,
  Index,
  Parameter,
  Parameters as CommandParameters,
  Problem,
  RowAxis,
} from '@latkit/model'
import { failure, selectRows, validateSelection } from '@latkit/model'

import type { ResultFormat } from '../results/decode.js'
import type { Case } from './case.js'
import type { Catalog, OptionSpec } from './definition.js'

export const FAULT = 'BusFault'
export interface Fault {
  readonly bus: number
  readonly start: number
  readonly duration: number
  readonly resistance: number
  readonly reactance: number
}
export interface SimulationCommand {
  readonly options: readonly { readonly option: OptionSpec; readonly value: number | string }[]
  readonly fault: Fault | null
  readonly format: ResultFormat
  readonly frames: number
  /** The times the run covers: from 0 to its end time. */
  readonly domain: Domain
}
/** One sampled output of a run. */
export interface Field {
  readonly name: string
  /** The physical row numbering `rows` belong to. */
  readonly index: Index
  /** Ascending and distinct. */
  readonly rows: Uint32Array
  readonly axis: RowAxis
}

export function parametersOf(catalog: Catalog): CommandParameters {
  const parameters: Record<string, Parameter> = Object.fromEntries(
    catalog.options.map((option) => [option.id, parameterOf(option)]),
  )
  if (catalog.shapes.has(FAULT))
    Object.assign(parameters, {
      fault: { label: 'Fault', type: 'boolean', default: false },
      fault_bus: {
        label: 'Bus',
        description: 'Required when fault is enabled.',
        type: 'reference',
        to: catalog.bus,
        optional: true,
      },
      fault_start: { label: 'Start', type: 'number', unit: 's', min: 0, default: 1 },
      fault_duration: { label: 'Duration', type: 'number', unit: 's', min: 0, default: 0.1 },
      fault_R: { label: 'Resistance', type: 'number', unit: 'pu', min: 0, default: 0 },
      fault_X: { label: 'Reactance', type: 'number', unit: 'pu', min: 0, default: 0.01 },
    })
  parameters.output_format = {
    label: 'Results format',
    type: 'choice',
    default: 'arrow',
    choices: ['arrow', 'csv'],
  }
  return parameters
}

function parameterOf(option: OptionSpec): Parameter {
  const head = {
    label: option.label,
    ...(option.description !== undefined && { description: option.description }),
    ...(option.optional === true && { optional: true }),
  }
  if (option.type === 'choice')
    return {
      ...head,
      type: 'choice',
      choices: (option.choices ?? []).map((choice) => choice.id),
      ...(typeof option.default === 'string' && { default: option.default }),
    }
  return {
    ...head,
    type: 'number',
    ...(option.type === 'integer' && { integer: true }),
    ...(option.unit !== undefined && { unit: option.unit }),
    ...(option.bounds?.lower && { min: option.bounds.lower.value }),
    ...(option.bounds?.upper && { max: option.bounds.upper.value }),
    ...(typeof option.default === 'number' && { default: option.default }),
  }
}

/** The run `values` describe. They have already passed Latkit's defaults, types, choices and inclusive bounds. */
export function commandOf(kase: Case, values: Arguments<CommandParameters>): SimulationCommand {
  const problems: Problem[] = []
  const problem = (name: string, message: string) =>
    problems.push({
      code: 'invalid-input',
      message,
      target: { kind: 'path', path: ['values', name] },
    })
  for (const option of kase.catalog.options) {
    const value = values[option.id]
    if (typeof value !== 'number') continue
    const { lower, upper } = option.bounds ?? {}
    if (lower?.inclusive === false && value <= lower.value)
      problem(option.id, `${option.label} must be above ${lower.value}.`)
    if (upper?.inclusive === false && value >= upper.value)
      problem(option.id, `${option.label} must be below ${upper.value}.`)
  }
  let fault: Fault | null = null
  if (values.fault === true) {
    const found = typeof values.fault_bus === 'string' ? kase.locate(values.fault_bus) : null
    if (found?.table.shape.type !== kase.catalog.bus)
      problem('fault_bus', 'The fault must reference a bus in this case.')
    if (
      (values.fault_start as number) + (values.fault_duration as number) >
      (values.tmax as number)
    )
      problem('fault_duration', 'The fault must clear by the end time.')
    if (found)
      fault = {
        bus: kase.native(found.table, found.row) as number,
        start: values.fault_start as number,
        duration: values.fault_duration as number,
        resistance: values.fault_R as number,
        reactance: values.fault_X as number,
      }
  }
  if (problems.length) throw failure('invalid-input', problems[0]!.message, { issues: problems })
  const options = kase.catalog.options.flatMap((option) => {
    const value = values[option.id]
    return value === undefined ? [] : [{ option, value: value as number | string }]
  })
  const events = fault === null ? [] : [fault.start, fault.start + fault.duration]
  const frames = framesOf(values.dt_monitor as number, values.tmax as number, events)
  if (!Number.isSafeInteger(frames) || frames < 0)
    throw failure(
      'invalid-input',
      'The requested interval produces an unrepresentable frame count.',
    )
  return {
    options,
    fault,
    format: values.output_format as ResultFormat,
    frames,
    domain: [0, values.tmax as number],
  }
}

/** One run's output plan; there is no subscriber union. */
export function selections(kase: Case, requested: readonly FieldSelection[]): readonly Field[] {
  const fields: Field[] = []
  const seen = new Set<string>()
  for (const selection of requested) {
    const problems = validateSelection(kase.schema, selection)
    if (problems.length) throw failure('invalid-input', problems[0]!.message, { issues: problems })
    const table = kase.data.tables[selection.from]!
    const rows = sorted(selectRows(table, selection.rows))
    if (rows.some((row, i) => i > 0 && row === rows[i - 1]))
      throw failure('invalid-input', 'A row is selected twice.')
    for (const name of selection.select) {
      const key = `${selection.from}.${name}`
      if (!kase.schema.types[selection.from]!.fields[name]!.sampled)
        throw failure(
          'invalid-input',
          `${key} is not a sampled output; read static fields with monitor().`,
        )
      if (seen.has(key)) throw failure('invalid-input', `${key} is selected twice.`)
      seen.add(key)
      if (rows.length) fields.push(outputOf(table.index, name, rows))
    }
  }
  return fields
}

/** One sampled output of a run; `rows` ascending and distinct. */
export function outputOf(index: Index, name: string, rows: Uint32Array): Field {
  return {
    name,
    index,
    rows,
    axis: rows.every((row, i) => row === rows[0]! + i)
      ? { kind: 'range', offset: rows[0] ?? 0, count: rows.length }
      : { kind: 'indices', values: rows },
  }
}

/** Owned and ascending: the caller may reuse its selection arrays once the run starts. */
function sorted(axis: RowAxis): Uint32Array {
  if (axis.kind === 'indices') return axis.values.slice().sort()
  const rows = new Uint32Array(axis.count)
  for (let i = 0; i < rows.length; i++) rows[i] = axis.offset + i
  return rows
}

/**
 * How many frames DynamicSimulation writes: one as it starts and one more as it starts again after each event,
 * then one per interval in each span between events (just the span's end when the interval is zero). A target
 * within rounding of a span's end counts as the end, as GridKit folds it.
 */
function framesOf(interval: number, end: number, events: readonly number[]): number {
  let count = 1 + events.length
  let from = 0
  for (const to of [...events, end]) {
    if (interval > 0)
      count += Math.ceil(
        (to - from) / interval -
          (Number.EPSILON * Math.max(Math.abs(from), Math.abs(to), 1)) / interval,
      )
    else count += 1
    from = to
  }
  return count
}
