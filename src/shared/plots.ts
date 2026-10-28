/** What the Monitor plots: a recorded field of a type, of every element or of the one `id` names. */

import { type CaseDefinition, fieldDefinition, fieldLabel, tableDefinition } from './document.js'
import type { Plot } from './messages.js'
import type { Results } from './simulation.js'

/** Whether `a` and `b` plot the same. */
export const samePlot = (a: Plot, b: Plot): boolean =>
  a.from === b.from && a.field === b.field && a.id === b.id

/** Whether `results` hold the field `plot` draws. */
export const holdsPlot = (
  results: Pick<Results, 'outputs'> | undefined,
  { from, field }: Pick<Plot, 'from' | 'field'>,
): boolean => !!results?.outputs.some((output) => output.table === from && output.field === field)

/** The plots `results` can draw: those of fields they hold, else their first field. */
export function plotsFor(results: Pick<Results, 'outputs'>, plots: readonly Plot[]): Plot[] {
  const kept = plots.filter((plot) => holdsPlot(results, plot))
  const first = results.outputs[0]
  return kept.length || !first ? kept : [{ from: first.table, field: first.field }]
}

/** A plot's name: its type, the element when it plots one, and its field, as "Bus 16 · Va [rad]". */
export function plotName(document: CaseDefinition | undefined, plot: Plot): string {
  if (!document) return plot.field
  const element = plot.id === undefined ? '' : ' ' + String(plot.id)
  const field = fieldDefinition(document, plot.from, plot.field)
  return (
    (tableDefinition(document, plot.from)?.label ?? plot.from) +
    element +
    ' · ' +
    (field ? fieldLabel(field) : plot.field)
  )
}
