/** What the Monitor plots: a recorded field of a type, of every element or of the one `id` names. */

import type { Schema } from '@latkit/model'

import { native } from './cells.js'
import type { Plot } from './messages.js'
import { fieldName, typeName } from './schema.js'
import type { Results } from './simulation.js'

/** Whether `a` and `b` plot the same. */
export const samePlot = (a: Plot, b: Plot): boolean =>
  a.from === b.from && a.field === b.field && a.id === b.id

/** Whether `results` hold the field `plot` draws. */
export const holdsPlot = (
  results: Pick<Results, 'outputs'> | undefined,
  { from, field }: Pick<Plot, 'from' | 'field'>,
): boolean =>
  !!results?.outputs.some((output) => output.from === from && output.select.includes(field))

/** A plot's name: its type, the element when it plots one, and its field, as "Bus 16 · Va [rad]". */
export function plotName(schema: Schema | undefined, plot: Plot): string {
  if (!schema) return plot.field
  const element = plot.id ? ` ${native(plot.id)}` : ''
  const definition = schema.types[plot.from]?.fields[plot.field]
  return `${typeName(schema, plot.from)}${element} · ${fieldName(definition, plot.field)}`
}
