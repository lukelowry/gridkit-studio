/** Where a case's records and their fields are in its file, as VS Code counts: in UTF-16 units. */

import { type Entity, entityLabel } from '../shared/document.js'
import { problem } from '../shared/errors.js'
import type { Case, Table } from './case.js'
import { charsAt, type Span } from './offsets.js'
import { Members } from './parse.js'

const OPEN_OBJECT = 0x7b
const members = new Members()

/** A stretch of a file's bytes: from its first to just past its last. */
type Bytes = readonly [start: number, end: number]

/** The UTF-16 offset of `byte` in the case's file, as VS Code counts. */
export const textOffset = (kase: Case, byte: number): number => charsAt(kase.file, byte)

/** The record of row `row` of `table`. The case's own row is no record, and stands in its header,
 *  or at the file's first character where it writes none, so nothing of it reads the whole file. */
function recordOf(kase: Case, table: Table, row: number): Bytes {
  if (table.shape.array === null) {
    const header = kase.member('header')
    return header ? [header.value, header.end] : [0, 1]
  }
  const records = kase.arrays[table.shape.array]!
  const record = table.records[row]!
  return [records.starts[record]!, records.ends[record]!]
}

/** The value `path` leads to, key by key, from the value at `from`; undefined where a key names
 *  no member, or leads into what is no object. */
function within(file: Buffer, from: Bytes, path: readonly string[]): Bytes | undefined {
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

/** Where the record of `table` at `record` writes the value at `path`, the keys to it from the
 *  record's own; undefined where it writes none. The case's own members are those its file was
 *  laid out by, so nothing of the case's own reads the whole file. */
function memberAt(
  kase: Case,
  table: Table,
  record: Bytes,
  path: readonly string[],
): Bytes | undefined {
  if (table.shape.array !== null) return within(kase.file, record, path)
  const own = kase.member(path[0]!)
  return own && within(kase.file, [own.value, own.end], path.slice(1))
}

/** The record of row `row` of `table`, or its `field`'s value, or the record's first character
 *  where it writes none. */
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

/** Where the element `id` is, or its `field`, as `rowRange` places its row. */
export function sourceRange(kase: Case, id: Entity, field?: string): Span {
  const located = kase.locate(id)
  if (!located) throw problem('invalid-input', `${entityLabel(id)} is not in the case.`)
  return rowRange(kase, located.table, located.row, field)
}
