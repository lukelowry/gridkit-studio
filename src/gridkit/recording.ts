/** What a case records, and where: each element's `mon` list, and the case's `monitors`. GridKit
 *  writes a column for every output an element lists, so the lists are all a run records. */

import type { Summary } from '../shared/messages.js'
import type { Sink } from '../shared/study.js'
import type { Case, Part, Table } from './case.js'
import type { Shape } from './definition.js'
import { NONE, type Parsed } from './parse.js'
import { Turns } from './turns.js'

const decoder = new TextDecoder()

/** GridKit's name for `field`, an output of `table`. */
export function outputName(table: Table, field: string): string {
  const source = table.shape.plan.get(field)?.source
  return source?.kind === 'output' ? source.name : field
}

/** `name` in a `mon` list of a record of `shape`, as GridKit matches it: a bus's in any case, as its
 *  BusDataJSONParser reads it, a device's as written. */
const monKey = (shape: Shape, name: string) => (shape.kind === 'bus' ? name.toLowerCase() : name)

/** How many records of each table, by its code, list each output, by its `monKey`, in each range
 *  read: a list that names an output twice counts once. Counted once for each range. */
const counted = new WeakMap<Parsed, Map<number, Map<string, number>>>()

function countsOf(kase: Case, { parsed }: Part): Map<number, Map<string, number>> {
  let counts = counted.get(parsed)
  if (counts) return counts
  counts = new Map()
  const { codes, mons } = parsed
  for (let record = 0; record < codes.length; record++) {
    const from = mons[2 * record]!
    const code = codes[record]!
    if (from === 0 || code === NONE) continue
    const list = JSON.parse(
      decoder.decode(kase.file.subarray(from, mons[2 * record + 1]!)),
    ) as unknown
    if (!Array.isArray(list)) continue
    let named = counts.get(code)
    if (!named) counts.set(code, (named = new Map()))
    const shape = kase.coding.shapes[code]!
    for (const name of new Set(
      list.filter((name) => typeof name === 'string').map((name) => monKey(shape, name)),
    ))
      named.set(name, (named.get(name) ?? 0) + 1)
  }
  counted.set(parsed, counts)
  return counts
}

/** What the case records: how many of each type's elements list each output, whether any element
 *  of any class lists one, and the monitor GridKit writes to. Read a range at a time, until
 *  `signal` lets go. */
export async function recordingOf(
  kase: Case,
  signal = AbortSignal.any([]),
): Promise<Summary['recording']> {
  const work = new Turns(signal)
  /** By table, how many of its records list each name. */
  const named = new Map<Table, Map<string, number>>()
  let anything = false
  for (const part of kase.parts) {
    await work.step()
    for (const [code, counts] of countsOf(kase, part)) {
      anything ||= counts.size > 0
      const table = kase.tables.get(kase.coding.shapes[code]!.type)
      if (!table?.shape.outputOrder.size) continue
      let into = named.get(table)
      if (!into) named.set(table, (into = new Map()))
      for (const [name, count] of counts) into.set(name, (into.get(name) ?? 0) + count)
    }
  }
  // Each type in the case's order, and its outputs in its own.
  const listed: Record<string, Record<string, number>> = {}
  for (const table of kase.tables.values()) {
    const counts = named.get(table)
    if (!counts) continue
    for (const field of table.shape.outputOrder.keys()) {
      const count = counts.get(monKey(table.shape, outputName(table, field)))
      if (count) (listed[table.shape.type] ??= {})[field] = count
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
  const sinks = JSON.parse(
    decoder.decode(kase.file.subarray(monitors.value, monitors.end)),
  ) as unknown
  if (!Array.isArray(sinks)) return undefined
  let file = ''
  for (const sink of sinks) {
    const { file_name: name, format, delim = ',' } = (sink ?? {}) as Record<string, unknown>
    if (/^csv$/i.test(String(format)) && delim === ',') file = typeof name === 'string' ? name : ''
  }
  return file ? { file } : undefined
}
