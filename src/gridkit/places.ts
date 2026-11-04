/** Where a case's records and their fields are in its file, as VS Code counts: in UTF-16 units. */

import { findNodeAtLocation, type JSONPath, parseTree } from 'jsonc-parser'

import type { Entity } from '../shared/document.js'
import { problem } from '../shared/errors.js'
import type { Case, Table } from './case.js'
import type { FieldPlan } from './definition.js'
import { charsAt, type Span } from './offsets.js'

const decoder = new TextDecoder()
const OPEN_OBJECT = 0x7b

/** The UTF-16 offset of `byte` in the case's file, as VS Code counts. */
export const textOffset = (kase: Case, byte: number): number => charsAt(kase.file, byte)

/** What `read` gives of a record's text by jsonc-parser, which recurses as deep as the record
 *  nests: a record nested deeper than the stack holds is refused, as its own problem. */
export function nested<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof RangeError && /call stack/i.test(error.message))
      throw problem('invalid-input', 'This record nests its values too deeply to read.')
    throw error
  }
}

/** The tree of a record's `text`. */
const treeOf = (text: string) => nested(() => parseTree(text)!)

/** Where a field's value is in its record's JSON. */
function nativePath(field: FieldPlan): string[] {
  const source = field.source
  switch (source.kind) {
    case 'identity':
    case 'record':
      return [source.name]
    case 'header':
      return ['header', source.name]
    case 'parameter':
      return ['params', source.name]
    case 'initial':
      return ['init', source.name]
    case 'port':
      return [source.key, source.name]
    case 'extension':
      return ['extension', source.name]
    case 'found':
      return [...source.path]
    case 'output':
      return ['mon']
  }
}

/** The record of row `id`: its table and row, its JSON text, and that text's offset in the file. */
function recordOf(kase: Case, id: Entity) {
  const located = kase.locate(id)
  if (!located) throw problem('invalid-input', 'This element no longer exists.')
  return recordAt(kase, located.table, located.row)
}

/** The record of `row` of `table`, as `recordOf` gives it, found by its place alone. The case's own
 *  row is no record: its fields are in its `header` and `params`, each read alone, as `placeOf`
 *  finds them, and the row stands in its header. */
function recordAt(kase: Case, table: Table, row: number) {
  if (table.shape.array === null) {
    const header = objectOf(kase, 'header')
    return { table, row, text: header?.text ?? '', offset: header?.offset ?? 0 }
  }
  const start = kase.arrays[table.shape.array]!.starts[table.records[row]!]!
  return { table, row, text: recordText(kase, table, row), offset: textOffset(kase, start) }
}

/** The JSON text of the record of `row` of `table`, a table whose rows are records. */
function recordText(kase: Case, table: Table, row: number): string {
  const array = kase.arrays[table.shape.array!]!
  const record = table.records[row]!
  return decoder.decode(kase.file.subarray(array.starts[record]!, array.ends[record]!))
}

/** A part of the file a field is written in: its JSON text, the text's offset in the file, and the
 *  field's path in it. */
interface Place {
  readonly text: string
  readonly offset: number
  readonly path: JSONPath
}

/** The case's own object `name`, its `header` or its `params`, where it writes one. */
function objectOf(kase: Case, name: string): Omit<Place, 'path'> | undefined {
  const member = kase.member(name)
  if (!member || kase.file[member.value] !== OPEN_OBJECT) return undefined
  return {
    text: decoder.decode(kase.file.subarray(member.value, member.end)),
    offset: textOffset(kase, member.value),
  }
}

/** Where field `plan` of row `row` of `table` is written. A record holds its own fields; the case's
 *  are in its `header` and `params`, each read alone, so nothing of the case's own reads the whole
 *  file. Undefined where the case writes no such object. */
function placeOf(kase: Case, table: Table, row: number, plan: FieldPlan): Place | undefined {
  if (table.shape.array === null) {
    const path = nativePath(plan)
    const object = objectOf(kase, path[0]!)
    return object && { ...object, path: path.slice(1) }
  }
  const { text, offset } = recordAt(kase, table, row)
  return { text, offset, path: nativePath(plan) }
}

/** Row `id`'s record, or its `field`'s value, or the record's first character without one. */
export function sourceRange(kase: Case, id: Entity, field?: string): Span {
  const record = recordOf(kase, id)
  if (!field) return { offset: record.offset, length: Math.max(1, record.text.length) }
  const plan = record.table.shape.plan.get(field)
  const place = plan && placeOf(kase, record.table, record.row, plan)
  const node = place && findNodeAtLocation(treeOf(place.text), place.path)
  return node
    ? { offset: place.offset + node.offset, length: node.length }
    : { offset: place?.offset ?? record.offset, length: 1 }
}
