/** What a case records, and where: each element's `mon` list, and the case's `monitors`. GridKit
 *  writes a column for every output an element lists, so the lists are all a run records. */

import type { SourceEdit, Summary } from '../shared/messages.js'
import type { Sink } from '../shared/study.js'
import type { Case, Part, Table } from './case.js'
import { textOffsets } from './edits.js'
import { NONE, type Parsed } from './parse.js'
import { Turns } from './turns.js'

const decoder = new TextDecoder()

/** GridKit's name for `field`, an output of `table`. */
export function outputName(table: Table, field: string): string {
  const source = table.shape.plan.get(field)?.source
  return source?.kind === 'output' ? source.name : field
}

/** The outputs row `row` of `table` lists, as its file writes them. */
function listed(kase: Case, table: Table, row: number): string[] {
  const mons = kase.arrays[table.shape.array!]!.mons
  const record = table.records[row]!
  const from = mons[2 * record]!
  if (from === 0) return []
  const list = JSON.parse(decoder.decode(kase.file.subarray(from, mons[2 * record + 1]))) as unknown
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === 'string') : []
}

/** How many records of each table, by its code, list each output, by the name the file writes it
 *  under, in each range read: a list that names an output twice counts once. Counted once for each
 *  range, which a revision keeps where an edit leaves it alone. */
const counted = new WeakMap<Parsed, Map<number, Map<string, number>>>()

function countsOf(kase: Case, { parsed, shift }: Part): Map<number, Map<string, number>> {
  let counts = counted.get(parsed)
  if (counts) return counts
  counts = new Map()
  const { codes, mons } = parsed
  for (let record = 0; record < codes.length; record++) {
    const from = mons[2 * record]!
    const code = codes[record]!
    if (from === 0 || code === NONE) continue
    const list = JSON.parse(
      decoder.decode(kase.file.subarray(from + shift, mons[2 * record + 1]! + shift)),
    ) as unknown
    if (!Array.isArray(list)) continue
    let named = counts.get(code)
    if (!named) counts.set(code, (named = new Map()))
    for (const name of new Set(list))
      if (typeof name === 'string') named.set(name, (named.get(name) ?? 0) + 1)
  }
  counted.set(parsed, counts)
  return counts
}

/** What the case records: how many of each type's elements list each output, and the monitor
 *  GridKit writes to, its last CSV one as GridKit takes it. Read a range at a time, until `signal`
 *  lets go. */
export async function recordingOf(
  kase: Case,
  signal = AbortSignal.any([]),
): Promise<Summary['recording']> {
  const work = new Turns(signal)
  /** By table, how many of its records list each name. */
  const named = new Map<Table, Map<string, number>>()
  for (const part of kase.parts) {
    await work.step()
    for (const [code, counts] of countsOf(kase, part)) {
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
      const count = counts.get(outputName(table, field))
      if (count) (listed[table.shape.type] ??= {})[field] = count
    }
  }
  const monitor = monitorOf(kase)
  return { listed, ...(monitor && { monitor }) }
}

function monitorOf(kase: Case): Sink | undefined {
  const monitors = kase.member('monitors')
  if (!monitors) return undefined
  const sinks = JSON.parse(
    decoder.decode(kase.file.subarray(monitors.value, monitors.end)),
  ) as unknown
  if (!Array.isArray(sinks)) return undefined
  for (const sink of sinks.toReversed()) {
    const { file_name: file, format } = (sink ?? {}) as Record<string, unknown>
    if (typeof file === 'string' && file && /^csv$/i.test(String(format))) return { file }
  }
  return undefined
}

/** What one type of a case is to record: the outputs each of its elements is to list, and those
 *  none is to. */
export interface Recording {
  readonly type: string
  readonly add: readonly string[]
  readonly remove: readonly string[]
}

/** The edits that make every element of each type `recordings` name list the outputs in its `add`
 *  and none in its `remove`. A list keeps its order, and what it gains goes last. A record with no
 *  list gains one. Edits of records near one another, of whatever type, are one edit, with what lies
 *  between them: listing a field on every element is then a few edits, not one per element. */
export function recordEdits(kase: Case, recordings: readonly Recording[]): SourceEdit[] {
  /** Each record's change, by where it is in the file. */
  const changes: { start: number; end: number; text: string }[] = []
  for (const { type, add, remove } of recordings) {
    const table = kase.table(type)
    const array = table.shape.array && kase.arrays[table.shape.array]
    if (!array) continue
    const adding = add.map((field) => outputName(table, field))
    const removing = remove.map((field) => outputName(table, field))
    for (let row = 0; row < table.records.length; row++) {
      const before = listed(kase, table, row)
      const kept = before.filter((name) => !removing.includes(name))
      const after = [...kept, ...adding.filter((name) => !kept.includes(name))]
      if (after.length === before.length && after.every((name, n) => name === before[n])) continue
      const record = table.records[row]!
      const from = array.mons[2 * record]!
      const brace = array.ends[record]! - 1
      changes.push(
        from > 0
          ? { start: from, end: array.mons[2 * record + 1]!, text: JSON.stringify(after) }
          : { start: brace, end: brace, text: `, "mon": ${JSON.stringify(after)}` },
      )
    }
  }
  changes.sort((a, b) => a.start - b.start)
  const offsetOf = textOffsets(kase)
  const edits: SourceEdit[] = []
  /** The edit being made, and where it ends in the file, which the next change joins when near. */
  let last: { offset: number; length: number; text: string; end: number } | undefined
  for (const { start, end, text } of changes) {
    const offset = offsetOf(start)
    const length = offsetOf(end) - offset
    if (last && offset - (last.offset + last.length) <= JOIN_CHARS) {
      last.text += decoder.decode(kase.file.subarray(last.end, start)) + text
      last.length = offset + length - last.offset
      last.end = end
      continue
    }
    if (last) edits.push({ offset: last.offset, length: last.length, text: last.text })
    last = { offset, length, text, end }
  }
  if (last) edits.push({ offset: last.offset, length: last.length, text: last.text })
  return edits
}

/** How near one record's change must be to the last for the two to be one edit, in characters. */
const JOIN_CHARS = 4096
