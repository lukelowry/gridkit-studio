/** What a case records: each element's `mon` list and the case's `monitors`. GridKit writes a
 *  column for every listed output, so the lists define everything a run records. */

import { text } from '../platform/bytes.js'
import type { Summary } from '../shared/messages.js'
import type { Sink } from '../shared/study.js'
import type { Case, Table } from './case.js'
import type { Shape } from './definition.js'
import { STEP_RECORDS, Turns } from './turns.js'

/** GridKit's name for output `field` of `table`: its label, which differs from the field name when
 *  the field was renamed to avoid a clash. */
export function outputName(table: Table, field: string): string {
  const plan = table.shape.plan.get(field)
  return plan?.role === 'output' ? plan.definition.label : field
}

/** `name` as GridKit matches it in a `mon` list: case-insensitive for a bus, as BusDataJSONParser
 *  reads it, and exact for a device. */
const monKey = (shape: Shape, name: string) => (shape.kind === 'bus' ? name.toLowerCase() : name)

/** Per type, how many elements list each output, and the monitor GridKit writes to. */
export async function recordingOf(
  kase: Case,
  signal = AbortSignal.any([]),
): Promise<Summary['recording']> {
  const work = new Turns(signal)
  const listed: Record<string, Record<string, number>> = {}
  let anything = false
  for (const table of kase.tables.values()) {
    const { shape } = table
    const mons = shape.array === null ? undefined : kase.arrays[shape.array]?.mons
    if (!mons) continue
    /** Per name, how many records list it. A name listed twice in one record counts once. */
    const counts = new Map<string, number>()
    const { records } = table
    for (let row = 0; row < records.length; row++) {
      if ((row & STEP_RECORDS) === 0) await work.step()
      const from = mons[2 * records[row]!]!
      if (from === 0) continue
      const list: unknown = JSON.parse(text(kase.file, from, mons[2 * records[row]! + 1]!))
      if (!Array.isArray(list)) continue
      for (const name of new Set(
        list.filter((name) => typeof name === 'string').map((name) => monKey(shape, name)),
      ))
        counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    anything ||= counts.size > 0
    for (const field of shape.outputs) {
      const count = counts.get(monKey(shape, outputName(table, field)))
      if (count) (listed[shape.type] ??= {})[field] = count
    }
  }
  const monitor = monitorOf(kase)
  return { listed, anything, ...(monitor && { monitor }) }
}

/** The CSV file GridKit writes samples to, by parseStudyData's rule: the last comma-separated CSV
 *  monitor. A monitor without a file name leaves the choice to the solver file. */
function monitorOf(kase: Case): Sink | undefined {
  const monitors = kase.member('monitors')
  if (!monitors) return undefined
  const sinks: unknown = JSON.parse(text(kase.file, monitors.value, monitors.end))
  if (!Array.isArray(sinks)) return undefined
  let file = ''
  for (const sink of sinks) {
    const { file_name: name, format, delim = ',' } = (sink ?? {}) as Record<string, unknown>
    if (/^csv$/i.test(String(format)) && delim === ',') file = typeof name === 'string' ? name : ''
  }
  return file ? { file } : undefined
}
