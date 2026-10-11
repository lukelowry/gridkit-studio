/** What a case records, and where: each element's `mon` list, and the case's `monitors`. GridKit
 *  writes a column for every output an element lists, so the lists are all a run records. */

import type { SourceEdit, Summary } from '../shared/messages.js'
import type { Sink } from '../shared/study.js'
import type { Case, Table } from './case.js'
import { textOffset } from './edits.js'

const decoder = new TextDecoder()

/** GridKit's name for `field`, an output of `table`. */
function outputName(table: Table, field: string): string {
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

/** What the case records: how many of each type's elements list each output, and the monitor
 *  GridKit writes to, its last CSV one as GridKit takes it, or an Arrow one Studio reads too. */
export function recordingOf(kase: Case): Summary['recording'] {
  const listedCounts: Record<string, Record<string, number>> = {}
  for (const table of kase.tables.values()) {
    if (!table.shape.array || !table.shape.outputOrder.size) continue
    const fields = new Map(
      [...table.shape.outputOrder.keys()].map((field) => [outputName(table, field), field]),
    )
    for (let row = 0; row < table.records.length; row++)
      for (const name of listed(kase, table, row)) {
        const field = fields.get(name)
        if (field === undefined) continue
        const counts = (listedCounts[table.shape.type] ??= {})
        counts[field] = (counts[field] ?? 0) + 1
      }
  }
  const monitor = monitorOf(kase)
  return { listed: listedCounts, ...(monitor && { monitor }) }
}

function monitorOf(kase: Case): Sink | undefined {
  if (!kase.monitors) return undefined
  const sinks = JSON.parse(
    decoder.decode(kase.file.subarray(kase.monitors.value, kase.monitors.end)),
  ) as unknown
  if (!Array.isArray(sinks)) return undefined
  for (const sink of sinks.toReversed()) {
    const { file_name: file, format } = (sink ?? {}) as Record<string, unknown>
    if (typeof file === 'string' && file && /^(csv|arrow)$/i.test(String(format)))
      return { file, format: String(format).toLowerCase() as Sink['format'] }
  }
  return undefined
}

/** The edits that make every element of `type` list the outputs in `add` and none in `remove`. A
 *  list keeps its order, and what it gains goes last. A record with no list gains one. */
export function recordEdits(
  kase: Case,
  type: string,
  add: readonly string[],
  remove: readonly string[],
): SourceEdit[] {
  const table = kase.table(type)
  const array = table.shape.array && kase.arrays[table.shape.array]
  if (!array) return []
  const adding = add.map((field) => outputName(table, field))
  const removing = remove.map((field) => outputName(table, field))
  const edits: SourceEdit[] = []
  for (let row = 0; row < table.records.length; row++) {
    const before = listed(kase, table, row)
    const kept = before.filter((name) => !removing.includes(name))
    const after = [...kept, ...adding.filter((name) => !kept.includes(name))]
    if (after.length === before.length && after.every((name, n) => name === before[n])) continue
    const record = table.records[row]!
    const from = array.mons[2 * record]!
    const brace = array.ends[record]! - 1
    const [start, end] = from > 0 ? [from, array.mons[2 * record + 1]!] : [brace, brace]
    const offset = textOffset(kase, start)
    const text = JSON.stringify(after)
    edits.push({
      offset,
      length: textOffset(kase, end) - offset,
      text: from > 0 ? text : `, "mon": ${text}`,
    })
  }
  return edits
}
