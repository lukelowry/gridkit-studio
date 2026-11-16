/** The Monitor's monitors: one per recorded signal, listed as the results or the case record them. */

import type { Id } from 'latkit'

import type { ValueRange } from './data.js'
import {
  type CaseDefinition,
  type Field,
  fieldDefinition,
  fieldLabel,
  tableLabel,
} from './document.js'
import type { Monitor, Results, Summary } from './messages.js'

/** Whether `value` is a field: a type and field name. */
export const isField = (value: unknown): value is Field =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as Field).table === 'string' &&
  typeof (value as Field).field === 'string'

export const sameField = (a: Field, b: Field): boolean => a.table === b.table && a.field === b.field

/** The signals the Monitor lists: the outputs of `results` once its header is read, else what the
 *  case's `mon` lists record. */
export function signalsOf(
  results: Pick<Results, 'outputs'> | undefined,
  listed: Summary['recording']['listed'] | undefined,
): Field[] {
  if (results?.outputs.length) return results.outputs.map(({ table, field }) => ({ table, field }))
  return Object.entries(listed ?? {}).flatMap(([table, fields]) =>
    Object.entries(fields).flatMap(([field, count]) => (count > 0 ? [{ table, field }] : [])),
  )
}

/** The monitors `shown` names, in list order, or the first monitor when it names none. */
export function shownOf(monitors: readonly Monitor[], shown: readonly Field[]): Monitor[] {
  const found = monitors.filter((monitor) => shown.some((each) => sameField(each, monitor)))
  return found.length || !monitors[0] ? found : [monitors[0]]
}

/** `field` for element `id` (or every element) over `range` (or fitted to its values). */
export const monitorWith = (
  { table, field }: Field,
  id: Id | undefined,
  range: ValueRange | undefined,
): Monitor => ({
  table,
  field,
  ...(id !== undefined && { id }),
  ...(range && { range: [range[0], range[1]] as const }),
})

/** Whether `results` contain the field `monitor` plots. */
export const isRecorded = (results: Pick<Results, 'outputs'> | undefined, monitor: Field) =>
  !!results?.outputs.some((output) => sameField(output, monitor))

/** A monitor's name: type, element if any, and field, as in "Bus 16 · Va [rad]". */
export function monitorName(document: CaseDefinition | undefined, monitor: Monitor): string {
  if (!document) return monitor.field
  const element = monitor.id === undefined ? '' : ' ' + String(monitor.id)
  const field = fieldDefinition(document, monitor.table, monitor.field)
  return (
    tableLabel(document, monitor.table) +
    element +
    ' · ' +
    (field ? fieldLabel(field) : monitor.field)
  )
}
