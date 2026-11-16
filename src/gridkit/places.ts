/** Locates a case's records and fields in its file, as VS Code UTF-16 offsets. */

import { type Entity, entityLabel } from '../shared/document.js'
import { problem } from '../shared/errors.js'
import type { Case, Table } from './case.js'
import { charsAt, type Span } from './offsets.js'
import { Members } from './parse.js'

const OPEN_OBJECT = 0x7b
const members = new Members()

type ByteRange = readonly [start: number, end: number]

export const textOffset = (kase: Case, byte: number): number => charsAt(kase.file, byte)

/** The case's own row maps to its header, or to the first character, never the whole file. */
function recordOf(kase: Case, table: Table, row: number): ByteRange {
  if (table.shape.array === null) {
    const header = kase.member('header')
    return header ? [header.value, header.end] : [0, 1]
  }
  const records = kase.arrays[table.shape.array]!
  const record = table.records[row]!
  return [records.starts[record]!, records.ends[record]!]
}

/** The value at `path` inside the value at `from`, or undefined. */
function within(file: Uint8Array, from: ByteRange, path: readonly string[]): ByteRange | undefined {
  let [value, end] = from
  for (const key of path) {
    if (file[value] !== OPEN_OBJECT) return undefined
    const at = members.find(file, members.read(file, value), key)
    if (at < 0) return undefined
    value = members.spans[4 * at + 2]!
    end = members.spans[4 * at + 3]!
  }
  return [value, end]
}

/** The case's own row starts from the top-level members, so it never scans the whole file. */
function memberAt(
  kase: Case,
  table: Table,
  record: ByteRange,
  path: readonly string[],
): ByteRange | undefined {
  if (table.shape.array !== null) return within(kase.file, record, path)
  const own = kase.member(path[0]!)
  return own && within(kase.file, [own.value, own.end], path.slice(1))
}

/** The span of a record or of its `field`, or the record's first character when absent. */
export function rowRange(kase: Case, table: Table, row: number, field?: string): Span {
  const record = recordOf(kase, table, row)
  const plan = field === undefined ? undefined : table.shape.plan.get(field)
  const [from, to] =
    field === undefined
      ? record
      : ((plan && memberAt(kase, table, record, plan.path)) ?? [record[0], record[0] + 1])
  const offset = charsAt(kase.file, from)
  return { offset, length: charsAt(kase.file, to) - offset }
}

export function sourceRange(kase: Case, id: Entity, field?: string): Span {
  const located = kase.locate(id)
  if (!located) throw problem('invalid-input', `${entityLabel(id)} is not in the case.`)
  return rowRange(kase, located.table, located.row, field)
}
