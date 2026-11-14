/** What a case records, and where: each element's `mon` list, and the case's `monitors`. GridKit
 *  writes a column for every output an element lists, so the lists are all a run records. */

import type { Summary } from '../shared/messages.js'
import type { Sink } from '../shared/study.js'
import type { Case, Table } from './case.js'
import { utf8 } from './columns.js'
import type { Shape } from './definition.js'
import { STEP_RECORDS, Turns } from './turns.js'

/** GridKit's name for `field`, an output of `table`: its label, which its field's name differs
 *  from where a record's own member has it. */
export function outputName(table: Table, field: string): string {
  const plan = table.shape.plan.get(field)
  return plan?.role === 'output' ? plan.definition.label : field
}

/** `name` in a `mon` list of a record of `shape`, as GridKit matches it: a bus's in any case, as its
 *  BusDataJSONParser reads it, a device's as written. */
const monKey = (shape: Shape, name: string) => (shape.kind === 'bus' ? name.toLowerCase() : name)

/** What the case records: how many of each type's elements list each output, whether any element
 *  of any class lists one, and the monitor GridKit writes to. Read a slice of records at a time,
 *  until `signal` lets go. */
export async function recordingOf(
  kase: Case,
  signal = AbortSignal.any([]),
): Promise<Summary['recording']> {
  const work = new Turns(signal)
  // Each type in the case's order, and its outputs in its own.
  const listed: Record<string, Record<string, number>> = {}
  let anything = false
  for (const table of kase.tables.values()) {
    const { shape } = table
    const mons = shape.array === null ? undefined : kase.arrays[shape.array]?.mons
    if (!mons) continue
    /** How many of the table's records list each name: a list that names one twice counts once. */
    const counts = new Map<string, number>()
    const { records } = table
    for (let row = 0; row < records.length; row++) {
      if ((row & STEP_RECORDS) === 0) await work.step()
      const from = mons[2 * records[row]!]!
      if (from === 0) continue
      const list: unknown = JSON.parse(utf8(kase.file, from, mons[2 * records[row]! + 1]!))
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

/** The CSV file GridKit writes the case's samples to, by its own rule in parseStudyData: the last
 *  CSV monitor that separates with commas. One that names no file leaves it to the solver file. */
function monitorOf(kase: Case): Sink | undefined {
  const monitors = kase.member('monitors')
  if (!monitors) return undefined
  const sinks: unknown = JSON.parse(utf8(kase.file, monitors.value, monitors.end))
  if (!Array.isArray(sinks)) return undefined
  let file = ''
  for (const sink of sinks) {
    const { file_name: name, format, delim = ',' } = (sink ?? {}) as Record<string, unknown>
    if (/^csv$/i.test(String(format)) && delim === ',') file = typeof name === 'string' ? name : ''
  }
  return file ? { file } : undefined
}
