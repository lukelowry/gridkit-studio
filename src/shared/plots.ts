/** The Monitor's plots: which the results on show can draw, and what each is called. */

import {
  type CaseDefinition,
  type Field,
  fieldDefinition,
  fieldLabel,
  tableLabel,
} from './document.js'
import type { Plot } from './messages.js'
import type { Results } from './simulation.js'

/** Whether `value` names a plot: a field of a type. */
export const isPlot = (value: unknown): value is Plot =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as Plot).table === 'string' &&
  typeof (value as Plot).field === 'string'

/** Whether `a` and `b` plot the same. */
export const samePlot = (a: Plot, b: Plot): boolean =>
  a.table === b.table && a.field === b.field && a.id === b.id

/** `plot`'s field of the element `id`, or of every element with none, over the values `range`, or
 *  fitting the values it shows with none. */
export const plotWith = ({ table, field }: Plot, id: Plot['id'], range: Plot['range']): Plot => ({
  table,
  field,
  ...(id !== undefined && { id }),
  ...(range && { range: [range[0], range[1]] as const }),
})

/** Whether `results` hold the field `plot` draws. */
export const holdsPlot = (
  results: Pick<Results, 'outputs'> | undefined,
  { table, field }: Field,
): boolean => !!results?.outputs.some((output) => output.table === table && output.field === field)

/** The plots `results` can draw: those of fields they hold, else their first field. */
export function plotsFor(results: Pick<Results, 'outputs'>, plots: readonly Plot[]): Plot[] {
  const kept = plots.filter((plot) => holdsPlot(results, plot))
  const first = results.outputs[0]
  return kept.length || !first ? kept : [{ table: first.table, field: first.field }]
}

/** A plot's name: its type, the element when it plots one, and its field, as "Bus 16 · Va [rad]". */
export function plotName(document: CaseDefinition | undefined, plot: Plot): string {
  if (!document) return plot.field
  const element = plot.id === undefined ? '' : ' ' + String(plot.id)
  const field = fieldDefinition(document, plot.table, plot.field)
  return (
    tableLabel(document, plot.table) + element + ' · ' + (field ? fieldLabel(field) : plot.field)
  )
}
