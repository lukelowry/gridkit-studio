/** Monitor plot helpers: which plots the shown results can draw, and their names. */

import {
  type CaseDefinition,
  type Field,
  fieldDefinition,
  fieldLabel,
  tableLabel,
} from './document.js'
import type { Plot } from './messages.js'
import type { Results } from './simulation.js'

/** Whether `value` is a plot: a type and field name. */
export const isPlot = (value: unknown): value is Plot =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as Plot).table === 'string' &&
  typeof (value as Plot).field === 'string'

export const samePlot = (a: Plot, b: Plot): boolean =>
  a.table === b.table && a.field === b.field && a.id === b.id

/** `plot`'s field for element `id` (or every element) over `range` (or fitted to its values). */
export const plotWith = ({ table, field }: Plot, id: Plot['id'], range: Plot['range']): Plot => ({
  table,
  field,
  ...(id !== undefined && { id }),
  ...(range && { range: [range[0], range[1]] as const }),
})

/** Whether `results` contain the field `plot` draws. */
export const isRecorded = (
  results: Pick<Results, 'outputs'> | undefined,
  { table, field }: Field,
): boolean => !!results?.outputs.some((output) => output.table === table && output.field === field)

/** The plots `results` can draw, or their first field when none can. */
export function plotsFor(results: Pick<Results, 'outputs'>, plots: readonly Plot[]): Plot[] {
  const kept = plots.filter((plot) => isRecorded(results, plot))
  const first = results.outputs[0]
  return kept.length || !first ? kept : [{ table: first.table, field: first.field }]
}

/** A plot's name: type, element if any, and field, as in "Bus 16 · Va [rad]". */
export function plotName(document: CaseDefinition | undefined, plot: Plot): string {
  if (!document) return plot.field
  const element = plot.id === undefined ? '' : ' ' + String(plot.id)
  const field = fieldDefinition(document, plot.table, plot.field)
  return (
    tableLabel(document, plot.table) + element + ' · ' + (field ? fieldLabel(field) : plot.field)
  )
}
