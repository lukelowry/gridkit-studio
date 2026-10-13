/** A loaded case: its tables as column chunks, the Data a host reads, and the file as read. */

import { createHash, type Hash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import type { Data, Failure, Index, Schema } from '@latkit/model'
import { createData, failure } from '@latkit/model'
import { printParseErrorCode, visit } from 'jsonc-parser'

import { defect } from '../shared/errors.js'
import type { Value } from '../shared/messages.js'
import {
  builder,
  type Chunk,
  chunkAt,
  chunkOf,
  type Column,
  deferred,
  hash,
  isInt32,
  isValid,
  radixOrder,
  rowCount,
  utf8,
  valueAt,
} from './columns.js'
import {
  type ArrayName,
  CASE,
  CASE_ROW,
  type Catalog,
  type FieldPlan,
  type Shape,
  SIGNAL,
  withFound,
} from './definition.js'
import { carryOffsets, charsAt } from './offsets.js'
import {
  ARRAYS,
  type Coding,
  type Found,
  type IndexedChunk,
  isBounded,
  jsonText,
  type Layout,
  type Member,
  Members,
  NONE,
  type Parsed,
  Parser,
  PROBLEMS,
  type Range,
  type Records,
  recordsBetween,
  scan,
} from './parse.js'
import { Turns } from './turns.js'

export interface Table {
  readonly shape: Shape
  readonly index: Index
  /** Where each chunk starts, shared by every column; the last entry is the row count. */
  readonly starts: Uint32Array
  readonly ids: Column
  readonly fields: ReadonlyMap<string, Column>
  /** Each row's record in its array. */
  readonly records: Uint32Array
}

/** A field the catalog does not know, and the first row that has it. */
interface FoundField {
  readonly type: string
  readonly field: string
  readonly row: number
}

/** An array's records, and each one's `mon` value as a start and end; 0, 0 where it has none. */
interface RecordArray extends Records {
  readonly mons: Uint32Array
}

const RANGE_BYTES = 256 << 10
const UTF8 = new TextEncoder()
/** What a case keeps alive per byte of its source, and per field and per record of its tables. */
const SOURCE_BYTES = 4
const FIELD_BYTES = 24
const RECORD_BYTES = 80

export class Case {
  #signalsChecked = false
  #data: Data | undefined

  static async read(path: string, catalog: Catalog, signal?: AbortSignal): Promise<Case> {
    return Case.parse(await readFile(path, 'utf8'), catalog, basename(path, '.case.json'), signal)
  }

  /** The case `text` holds, parsed in ranges of about 256 KiB whose column chunks join their tables
   *  in file order without a copy. */
  static async parse(
    text: string,
    catalog: Catalog,
    name = 'Case',
    signal?: AbortSignal,
  ): Promise<Case> {
    signal?.throwIfAborted()
    const file = UTF8.encode(text)
    let layout: Layout
    try {
      layout = await scan(file, signal)
    } catch (error) {
      const byte = (error as { byte?: number }).byte
      if (byte === undefined) throw error
      // A file that is not JSON is read again the slower way, which says why as an editor does,
      // unless it nests deeper than that way reads.
      try {
        syntax(text)
      } catch (reason) {
        if (!(reason instanceof RangeError)) throw reason
      }
      throw Object.assign(error as Error, { offset: charsAt(file, byte) })
    }
    try {
      const parser = new Parser(catalog)
      const parts = await partsOf(file, rangesOf(layout), parser, signal)
      return assembled(file, layout, parts, parser.coding, catalog, name, hashOf(catalog, file))
    } catch (error) {
      // A record the parse refused, or the second of an id, says so where it is.
      const target = (error as Failure).target
      throw target?.kind === 'path'
        ? placed(error, file, layout.arrays[target.path[0] as ArrayName], target.path[1])
        : error
    }
  }

  /** The case `text` holds, read from `previous`, a case of an earlier text, as `name` names it when
   *  its header gives none. When the text differs only among the records of one array, those records
   *  alone are read again, and the ranges the edit leaves alone are kept, moved as it moved them:
   *  what they decoded stays decoded. Where those records are not JSON, it says so as a whole read
   *  would, from them alone. Otherwise, and wherever else the text does not read, it is read whole,
   *  which says why. A defect in reading the records alone, `defects` hears of; the text is read
   *  whole all the same. */
  static async revise(
    previous: Case,
    text: string,
    name = 'Case',
    signal?: AbortSignal,
    defects: (error: unknown) => void = () => {},
  ): Promise<Case> {
    signal?.throwIfAborted()
    const file = UTF8.encode(text)
    const edit = changed(previous.file, file)
    if (edit && !stale(previous))
      try {
        const revised = await revisionOf(previous, text, file, edit, name, signal)
        if (revised) {
          carryOffsets(previous.file, file, {
            start: edit.start,
            ended: edit.before,
            ends: edit.after,
          })
          return revised
        }
      } catch (error) {
        signal?.throwIfAborted()
        if (defect(error)) defects(error)
        else if (whole(error)) throw error
      }
    signal?.throwIfAborted()
    return Case.parse(text, previous.catalog, name, signal)
  }

  constructor(
    readonly name: string,
    readonly version: Index['version'],
    readonly catalog: Catalog,
    /** The catalog's types, with the classes and fields this case has that it does not know. */
    readonly schema: Schema,
    readonly tables: ReadonlyMap<string, Table>,
    /** The file as read. */
    readonly file: Uint8Array,
    readonly arrays: Readonly<Partial<Record<ArrayName, RecordArray>>>,
    /** The top-level object's closing brace. */
    readonly close: number,
    /** The case's own members, in file order: its header, params, arrays and monitors. */
    readonly members: readonly Member[],
    /** Every field the catalog does not know, where it is first. */
    readonly found: readonly FoundField[],
    /** The ranges its records were read in, which a revision of it keeps where an edit leaves
     *  them alone, and how their tables were coded. */
    readonly parts: readonly Part[],
    readonly coding: Coding,
    /** Its version's hash as it stood every HASH_BYTES of its file, which a revision hashes on from
     *  where the edit begins. */
    readonly hashes: readonly Hash[],
  ) {}

  /** The case's own member `name`, as `monitors`, where GridKit writes what the case records. */
  member(name: string): Member | undefined {
    return this.members.find((member) => member.name === name)
  }

  /** One immutable Data facade. Each field and row-ID column decodes on its first read. */
  get data(): Data {
    return (this.#data ??= dataOf(this.schema, this.tables))
  }

  /** The fewest bytes a case read from `text` keeps alive: its source and the spans into it. */
  static leastBytes(text: string): number {
    return text.length * SOURCE_BYTES
  }

  /** About how many bytes the case keeps alive, conservatively: its source and the spans into it,
   *  then per record its columns, and the indexes and graph built over its records. */
  get bytes(): number {
    let bytes = this.file.byteLength * SOURCE_BYTES
    for (const table of this.tables.values())
      bytes += table.records.length * (FIELD_BYTES * table.fields.size + RECORD_BYTES)
    return bytes
  }

  table(type: string): Table {
    const table = this.tables.get(type)
    if (table === undefined) throw failure('invalid-input', `No type is called ${type}.`)
    return table
  }

  cell(table: Table, field: string, row: number): Value {
    const column = field === table.shape.identity.name ? table.ids : table.fields.get(field)
    if (column === undefined)
      throw failure('invalid-input', `${table.shape.type} has no field ${field}.`)
    const chunk = chunkAt(column.starts, row)
    return valueAt(column.chunks[chunk]!, row - column.starts[chunk]!)
  }

  /** A row's native identity, as the file writes it. */
  native(table: Table, row: number): string | number {
    const chunk = chunkAt(table.starts, row)
    const ids = table.ids.chunks[chunk]!
    const i = ids.offset + row - table.starts[chunk]!
    return ids.kind === 'text'
      ? utf8(ids.bytes, ids.offsets[i]!, ids.offsets[i + 1]!)
      : (ids as Chunk.Numeric).values[i]!
  }

  /** The row with this native identity, or -1. */
  rowOf(table: Table, native: string | number): number {
    if (table.shape.identity.type === 'text')
      return typeof native === 'string' ? textIds(table).row(native) : -1
    const number =
      typeof native === 'number' ? native : /^(0|[1-9][0-9]*)$/.test(native) ? Number(native) : -1
    return number >= 0 && number <= 0xffffffff ? numberIds(table).row(number) : -1
  }

  /** A row's id: its type and native identity, such as `Bus/16`. */
  id(table: Table, row: number): string {
    return `${table.shape.type}/${this.native(table, row)}`
  }

  locate(id: string): { readonly table: Table; readonly row: number } | null {
    const slash = id.indexOf('/')
    const table = slash < 0 ? undefined : this.tables.get(id.slice(0, slash))
    const row = table === undefined ? -1 : this.rowOf(table, id.slice(slash + 1))
    return row < 0 ? null : { table: table!, row }
  }

  /** Throws when more than one output port drives a signal. */
  checkSignals(): void {
    if (this.#signalsChecked) return
    const signals = this.table(SIGNAL)
    const driven = new Uint8Array(Math.ceil(rowCount(signals.starts) / 8))
    for (const table of this.tables.values())
      for (const port of table.shape.ports) {
        if (port.definition.type.to !== SIGNAL || port.definition.direction !== 'out') continue
        for (const chunk of table.fields.get(port.name)!.chunks) {
          const reference = chunk as Chunk.Reference
          for (let at = 0; at < reference.length; at++) {
            if (!isValid(reference, at)) continue
            const row = reference.values[reference.offset + at]!
            const bit = 1 << (row & 7)
            if ((driven[row >>> 3]! & bit) !== 0) {
              const id = this.id(signals, row)
              throw failure('invalid-input', `${id} has more than one driver.`, {
                target: { kind: 'row', type: SIGNAL, id },
              })
            }
            driven[row >>> 3]! |= bit
          }
        }
      }
    this.#signalsChecked = true
  }
}

/** A range of records as a revision of a case read it: where it is in that revision's file, just
 *  past its last record, what was read of it, and how far its bytes lie past where they were read.
 *  A later revision keeps the ranges an edit leaves alone, moved as the edit moved them. */
export interface Part {
  readonly range: Range
  readonly end: number
  readonly parsed: Parsed
  readonly shift: number
}

/** A range of records, and just past its last. */
type Cut = Range & { readonly end: number }

/** The records of each array `layout` lays out, cut at record boundaries into ranges of about
 *  RANGE_BYTES. */
function rangesOf(layout: Layout): Cut[] {
  return ARRAYS.flatMap((array) => {
    const records = layout.arrays[array]
    return records ? cut(array, 0, records.starts, records.ends) : []
  })
}

/** Records `first` on of `array`, starting at `starts` and ending at `ends`, cut at record
 *  boundaries into ranges of about RANGE_BYTES. */
function cut(array: ArrayName, first: number, starts: Uint32Array, ends: Uint32Array): Cut[] {
  const ranges: Cut[] = []
  for (let from = 0; from < starts.length;) {
    let to = from + 1
    while (to < starts.length && ends[to]! - starts[from]! < RANGE_BYTES) to++
    ranges.push({
      array,
      first: first + from,
      starts: starts.subarray(from, to),
      end: ends[to - 1]!,
    })
    from = to
  }
  return ranges
}

/** `ranges` of `bytes` read by `parser`, range by range, in turns so `signal` can cancel. What a
 *  range refuses fails them all, saying where the first refusal is, and the first PROBLEMS in all. */
async function partsOf(
  bytes: Uint8Array,
  ranges: readonly Cut[],
  parser: Parser,
  signal?: AbortSignal,
): Promise<Part[]> {
  const work = new Turns(signal)
  const parts: Part[] = []
  for (const { end, ...range } of ranges) {
    await work.step()
    const parsed = parser.parse(bytes, range.array, range.first, range.starts)
    parts.push({ range, end, parsed, shift: 0 })
  }
  const problems = parts.flatMap(({ parsed }) => parsed.problems)
  const [first] = problems
  if (first)
    throw failure('invalid-input', first.message, {
      issues: problems.slice(0, PROBLEMS),
      ...(first.target && { target: first.target }),
    })
  return parts
}

/** How many bytes of a file its hash takes in between the states a revision may hash on from. */
const HASH_BYTES = 1 << 20

/** The version of `file` read with `catalog`, and the hash as it stood every HASH_BYTES: hashed on
 *  from the last of `kept` at or before byte `same`, past which `file` differs from the file they
 *  were taken of, else whole. A kept state is copied, never hashed on itself. */
function hashOf(
  catalog: Catalog,
  file: Uint8Array,
  kept: readonly Hash[] = [],
  same = 0,
): { readonly version: string; readonly hashes: readonly Hash[] } {
  const reused = Math.min(kept.length, Math.floor(same / HASH_BYTES) + 1)
  const hashes = kept.slice(0, reused)
  const hash = reused ? hashes[reused - 1]!.copy() : createHash('sha256').update(catalog.text)
  if (!reused) hashes.push(hash.copy())
  for (let at = Math.max(0, reused - 1) * HASH_BYTES; at < file.length;) {
    const next = Math.min(file.length, at + HASH_BYTES)
    hash.update(file.subarray(at, next))
    at = next
    if (at < file.length) hashes.push(hash.copy())
  }
  return { version: hash.digest('hex').slice(0, 32), hashes }
}

/** The case of `file`, as `layout` lays it out and `parts`, coded as `coding` says, read its
 *  records, of the version `hashed` says; `name` names it when its header gives none. Its identity
 *  indexes are built, so an id two rows share fails it. */
function assembled(
  file: Uint8Array,
  layout: Layout,
  parts: readonly Part[],
  coding: Coding,
  catalog: Catalog,
  name: string,
  hashed: ReturnType<typeof hashOf>,
): Case {
  // What each range has yet to decode is read from this file, where its bytes lie now.
  for (const { parsed, shift } of parts) {
    parsed.source.bytes = file
    parsed.source.shift = shift
  }
  const { version, hashes } = hashed
  const kase = joined(parts, coding, file, layout, catalog, version, name, hashes)
  for (const table of kase.tables.values())
    if (table.shape.identity.type === 'text') textIds(table)
    else numberIds(table)
  return kase
}

/** `spans`, pairs of a start and an end, `shift` further on; a pair 0, 0 says none, and stays. */
function shifted(spans: Uint32Array, shift: number): Uint32Array {
  if (!shift) return spans
  const moved = new Uint32Array(spans.length)
  for (let i = 0; i < spans.length; i += 2)
    if (spans[i] !== 0) {
      moved[i] = spans[i]! + shift
      moved[i + 1] = spans[i + 1]! + shift
    }
  return moved
}

/** The parsed ranges as one case: chunks joined in file order, ports resolved, records placed. A
 *  class the catalog does not know that no record has any more has no table. */
function joined(
  parts: readonly Part[],
  coding: Coding,
  file: Uint8Array,
  layout: Layout,
  catalog: Catalog,
  version: Index['version'],
  fallback: string,
  hashes: readonly Hash[],
): Case {
  const { shapes } = coding
  const chunks = shapes.map((shape) => ({
    ids: [] as Chunk[],
    fields: shape.fields.map((): IndexedChunk[] => []),
    ports: shape.ports.map((): IndexedChunk[] => []),
  }))
  const records = shapes.map((): number[] => [])
  const found: (Found & { readonly first: number })[] = []
  const mons = new Map<ArrayName, Uint32Array[]>()
  for (const { range, parsed, shift } of parts) {
    const { tables, codes } = parsed
    for (let i = 0; i < codes.length; i++)
      if (codes[i] !== NONE) records[codes[i]!]!.push(range.first + i)
    for (const member of parsed.found)
      found.push({
        ...member,
        first: range.first,
        value: member.value + shift,
        end: member.end + shift,
      })
    tables.forEach((table, code) => {
      if (table === null) return
      const into = chunks[code]!
      into.ids.push(...table.ids)
      table.fields.forEach((field, i) => into.fields[i]!.push(...field))
      table.ports.forEach((port, i) => into.ports[i]!.push(...port))
    })
    mons.set(range.array, [...(mons.get(range.array) ?? []), shifted(parsed.mons, shift)])
  }
  const tables = new Map<string, Table>()
  const index = (type: string): Index => ({ source: version, type, version })
  // One order of tables for any read, however its ranges were coded: the catalog's in its order,
  // then each class it does not know in the order its first record has in its array. A class no
  // record has any more has no table.
  const known = catalog.codes.length
  const order = shapes
    .map((_, code) => code)
    .filter((code) => code < known || records[code]!.length > 0)
    .sort((a, b) => (a < known || b < known ? a - b : records[a]![0]! - records[b]![0]!))
  for (const code of order) {
    const shape = shapes[code]!
    const { ids, fields } = chunks[code]!
    const decoded = fields.map((parts) => deferred(() => parts.map((part) => part.read())))
    const starts = startsOf(ids)
    const column = (type: Schema.FieldType, list: readonly Chunk[]): Column => ({
      type,
      chunks: list,
      starts,
    })
    tables.set(shape.type, {
      shape,
      index: index(shape.type),
      starts,
      ids: column(shape.identity.type, ids),
      fields: new Map(
        shape.fields.map((field, i) => [
          field.name,
          {
            type: field.definition.type,
            starts,
            get chunks() {
              return decoded[i]!()
            },
            // Each chunk's own, found as it decoded, as rows of the table.
            wrong: deferred(() =>
              fields[i]!.flatMap((part, c) => Array.from(part.wrong(), (at) => starts[c]! + at)),
            ),
          },
        ]),
      ),
      records: Uint32Array.from(records[code]!),
    })
  }
  // Ports become references once every table they can name is in place.
  for (const code of order) {
    const shape = shapes[code]!
    const table = tables.get(shape.type)!
    shape.ports.forEach((port, i) => {
      const target = tables.get(port.definition.type.to)!
      ;(table.fields as Map<string, Column>).set(
        port.name,
        references(chunks[code]!.ports[i]!, table.starts, target),
      )
    })
  }
  const fields = foundColumns(file, found, records, shapes, tables)
  const header = caseTable(file, layout, catalog.shapes.get(CASE)!, version)
  tables.set(CASE, header)
  const types: Record<string, Schema.Type> = Object.create(null)
  for (const [type, table] of tables) types[type] = table.shape.definition
  const arrays: Partial<Record<ArrayName, RecordArray>> = {}
  for (const array of ARRAYS) {
    const spans = layout.arrays[array]
    if (spans !== undefined) arrays[array] = { ...spans, mons: concatenated(mons.get(array) ?? []) }
  }
  const name = valueAt(header.fields.get('header.case_name')!.chunks[0]!, 0)
  return new Case(
    typeof name === 'string' && name !== '' ? name : fallback,
    version,
    catalog,
    { ...catalog.schema, types },
    tables,
    file,
    arrays,
    layout.close,
    layout.members,
    fields,
    parts,
    coding,
    hashes,
  )
}

/** How many bytes are compared at once, natively, as two files are told apart. */
const COMPARED_BYTES = 1 << 16

/** Whether `count` bytes of `a` at `at` are those of `b` at `bt`. */
const same = (a: Uint8Array, at: number, b: Uint8Array, bt: number, count: number) =>
  Buffer.from(a.buffer, a.byteOffset + at, count).equals(
    Buffer.from(b.buffer, b.byteOffset + bt, count),
  )

/** Where `after` differs from `before`: from `start`, which both share the bytes before, up to
 *  `before` in the one and `after` in the other, past which both share the rest; undefined where
 *  they are the same. */
function changed(
  before: Uint8Array,
  after: Uint8Array,
): { start: number; before: number; after: number } | undefined {
  const shorter = Math.min(before.length, after.length)
  let start = 0
  while (start + COMPARED_BYTES <= shorter && same(before, start, after, start, COMPARED_BYTES))
    start += COMPARED_BYTES
  while (start < shorter && before[start] === after[start]) start++
  if (start === shorter && before.length === after.length) return undefined
  // The bytes both end with, as far back as the bytes neither shares at their start.
  const room = shorter - start
  let tail = 0
  while (
    tail + COMPARED_BYTES <= room &&
    same(
      before,
      before.length - tail - COMPARED_BYTES,
      after,
      after.length - tail - COMPARED_BYTES,
      COMPARED_BYTES,
    )
  )
    tail += COMPARED_BYTES
  while (tail < room && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  return { start, before: before.length - tail, after: after.length - tail }
}

/** `previous` read again as `file`, which differs from its file only from `edit.start`, as
 *  `changed` says: undefined unless the edit lies among the records of one array, past its opening
 *  bracket and before its closing one. Then the records from the range the edit begins in to the
 *  range it ends in are read again, and the rest are kept, those after the edit moved by as much as
 *  it grew. */
async function revisionOf(
  previous: Case,
  text: string,
  file: Uint8Array,
  edit: { start: number; before: number; after: number },
  name: string,
  signal?: AbortSignal,
): Promise<Case | undefined> {
  const grown = edit.after - edit.before
  const array = ARRAYS.find((each) => {
    const records = previous.arrays[each]
    return records && records.open < edit.start && edit.before <= records.close
  })
  if (!array) return undefined
  const old = previous.arrays[array]!
  const parts = previous.parts
  const own = parts.flatMap((part, p) => (part.range.array === array ? [p] : []))
  // The ranges the edit begins and ends in, or none, where it begins before the first record or
  // ends past the last: what they hold is read again, from the first range's first record, or the
  // array's start, to the last range's last record, or the array's end.
  const first = own.findLast((p) => parts[p]!.range.starts[0]! < edit.start)
  const last = own.find((p) => parts[p]!.end - 1 >= edit.before)
  const from = first === undefined ? old.open + 1 : parts[first]!.range.starts[0]!
  const closing = last === undefined
  const to = closing ? old.close + grown : parts[last]!.end + grown
  let read: { starts: Uint32Array; ends: Uint32Array }
  try {
    read = await recordsBetween(file, from, to, closing, signal)
  } catch (error) {
    throw isBounded(error) || (error as { byte?: unknown }).byte === undefined
      ? error
      : misread(previous, text, file, from, to, error)
  }
  // The ranges of the array kept before and after those read again, and how many records the edit
  // took and gave.
  const before = own.filter((p) => first !== undefined && p < first).map((p) => parts[p]!)
  const after = own.filter((p) => last !== undefined && p > last).map((p) => parts[p]!)
  const recordsBefore = first === undefined ? 0 : parts[first]!.range.first
  const removed =
    old.starts.length -
    [...before, ...after].reduce((sum, part) => sum + part.range.starts.length, 0)
  const added = read.starts.length - removed
  const parser = new Parser(previous.catalog, previous.coding)
  const fresh = await partsOf(
    file,
    cut(array, recordsBefore, read.starts, read.ends),
    parser,
    signal,
  )
  /** `part`, kept where the edit leaves it, or moved past it. */
  const moved = (part: Part): Part =>
    part.range.starts[0]! < edit.start
      ? part
      : {
          range: {
            array: part.range.array,
            first: part.range.first + (part.range.array === array ? added : 0),
            starts: part.range.starts.map((start) => start + grown),
          },
          end: part.end + grown,
          parsed: part.parsed,
          shift: part.shift + grown,
        }
  const ordered = ARRAYS.flatMap((each) =>
    each === array
      ? [...before, ...fresh, ...after.map(moved)]
      : parts.filter((part) => part.range.array === each).map(moved),
  )
  const at = (offset: number) => (offset >= edit.before ? offset + grown : offset)
  const layout: Layout = {
    members: previous.members.map((member) =>
      member.start >= edit.before
        ? {
            name: member.name,
            start: member.start + grown,
            value: member.value + grown,
            end: member.end + grown,
          }
        : member.end >= edit.before
          ? { ...member, end: member.end + grown }
          : member,
    ),
    close: previous.close + grown,
    arrays: Object.fromEntries(
      ARRAYS.flatMap((each): [ArrayName, Records][] => {
        const records = previous.arrays[each]
        if (!records) return []
        if (each !== array) {
          if (records.open < edit.start) return [[each, records]]
          return [
            [
              each,
              {
                open: records.open + grown,
                close: records.close + grown,
                starts: records.starts.map((start) => start + grown),
                ends: records.ends.map((end) => end + grown),
              },
            ],
          ]
        }
        const keptBefore = recordsBefore
        const keptAfter = old.starts.length - keptBefore - removed
        const join = (column: Uint32Array, middle: Uint32Array) => {
          const joined = new Uint32Array(keptBefore + middle.length + keptAfter)
          joined.set(column.subarray(0, keptBefore))
          joined.set(middle, keptBefore)
          joined.set(
            column.subarray(keptBefore + removed).map((offset) => offset + grown),
            keptBefore + middle.length,
          )
          return joined
        }
        return [
          [
            each,
            {
              open: records.open,
              close: at(records.close),
              starts: join(records.starts, read.starts),
              ends: join(records.ends, read.ends),
            },
          ],
        ]
      }),
    ),
  }
  return assembled(
    file,
    layout,
    ordered,
    parser.coding,
    previous.catalog,
    name,
    hashOf(previous.catalog, file, previous.hashes, edit.start),
  )
}

/** Whether `kase` was coded with classes the catalog does not know that none of its records has any
 *  more, as typing a class name leaves each start of it: a whole read codes it anew. */
function stale(kase: Case): boolean {
  let present = 0
  for (const type of kase.tables.keys()) if (!kase.catalog.shapes.has(type)) present++
  return kase.coding.unknown.size > present
}

/** Whether `error` says why a file does not read as a whole read of it says so. */
const whole = (error: unknown): boolean => (error as { whole?: unknown } | null)?.whole === true

/** `error`, which a read of `file`'s records met between byte `from` and `to`, said as a whole read
 *  of `text` says it, and where. The bytes before `from` are those `previous` read, so a whole read
 *  reads them alike, meets the same at the same byte, and `previous` places them. The editor's own
 *  reading says why, of those records alone, as an array of their own; else the read's. */
function misread(
  previous: Case,
  text: string,
  file: Uint8Array,
  from: number,
  to: number,
  error: unknown,
): Error {
  const start = charsAt(previous.file, from)
  const byte = (error as { byte: number }).byte
  const records =
    '[' + text.slice(start, start + utf8(file, from, Math.min(file.length, to + 1)).length)
  try {
    syntax(records)
  } catch (reason) {
    const at = (reason as { offset?: unknown }).offset
    // Where the records end the array this reading gives them is unclosed, which says nothing.
    if (!(reason instanceof RangeError) && typeof at === 'number' && at < records.length)
      return Object.assign(reason as Error, { offset: start + at - 1, whole: true })
  }
  return Object.assign(error as Error, {
    offset: start + utf8(file, from, byte).length,
    whole: true,
  })
}

/** `error`, placed on record `record` of `records`: where that record lies in `file`. */
function placed(
  error: unknown,
  file: Uint8Array,
  records: Records | undefined,
  record: unknown,
): unknown {
  if (!records || typeof record !== 'number' || !(record < records.starts.length)) return error
  const start = records.starts[record]!
  const offset = charsAt(file, start)
  const length = utf8(file, start, records.ends[record]!).length
  return Object.assign(error as Error, { offset, length })
}

/** Throws why `text` is not JSON, as an editor says it: the first problem, at its place in the
 *  text, or a key an object repeats. */
function syntax(text: string): void {
  const objects: Set<string>[] = []
  visit(
    text,
    {
      onObjectBegin: () => {
        objects.push(new Set())
      },
      onObjectEnd: () => {
        objects.pop()
      },
      onObjectProperty: (name, offset, length) => {
        const keys = objects.at(-1)!
        if (keys.has(name))
          throw Object.assign(failure('invalid-input', 'Duplicate JSON property: ' + name), {
            offset,
            length,
          })
        keys.add(name)
      },
      onError: (error, offset, length) => {
        // `PropertyNameExpected` reads as `Invalid JSON: property name expected`.
        const problem = printParseErrorCode(error).replace(/(?<=[a-z])(?=[A-Z])/g, ' ')
        throw Object.assign(failure('invalid-input', 'Invalid JSON: ' + problem.toLowerCase()), {
          offset,
          length,
        })
      },
    },
    { disallowComments: true, allowTrailingComma: false },
  )
}

/** Each member the catalog does not know as a column of its table, typed by its values: numbers,
 *  booleans or strings as they are, anything else as its JSON text. Tables that have one take a
 *  shape with it; returns where each is first. */
function foundColumns(
  file: Uint8Array,
  found: readonly (Found & { readonly first: number })[],
  records: readonly (readonly number[])[],
  shapes: readonly Shape[],
  tables: Map<string, Table>,
): FoundField[] {
  const byCode = new Map<number, Map<string, (Found & { readonly first: number })[]>>()
  for (const member of found) {
    let fields = byCode.get(member.code)
    if (!fields) byCode.set(member.code, (fields = new Map()))
    // A key with a point in it is quoted, so it never reads as a path through a known record key.
    const name = member.path.map((key) => (key.includes('.') ? JSON.stringify(key) : key)).join('.')
    let members = fields.get(name)
    if (!members) fields.set(name, (members = []))
    members.push(member)
  }
  const firsts: FoundField[] = []
  for (const [code, fields] of byCode) {
    const shape = shapes[code]!
    const table = tables.get(shape.type)!
    const rows = new Map(records[code]!.map((record, row) => [record, row]))
    const plans: FieldPlan[] = []
    const columns = new Map(table.fields)
    for (const [name, members] of fields) {
      const locations = new Map(
        members.map((member) => [rows.get(member.first + member.record)!, member]),
      )
      // JSON syntax is already checked. Its first byte determines the scalar type without
      // allocating strings or parsing unrelated extension objects on the opening path. A null is
      // a missing value, which a column of any type holds.
      const kinds = new Set(
        members.flatMap(({ value }) => {
          const first = file[value]!
          if (first === 0x6e) return []
          return [
            first === 0x22
              ? 'string'
              : first === 0x74 || first === 0x66
                ? 'boolean'
                : first === 0x2d || (first >= 0x30 && first <= 0x39)
                  ? 'number'
                  : 'object',
          ]
        }),
      )
      const scalar = kinds.size <= 1 && !kinds.has('object')
      const type: Schema.FieldType = !scalar
        ? 'text'
        : kinds.has('number')
          ? 'float64'
          : kinds.has('boolean')
            ? 'boolean'
            : 'text'
      const decode = deferred(() => {
        const cell = (row: number): Value => {
          const member = locations.get(row)
          if (!member) return null
          const value = JSON.parse(utf8(file, member.value, member.end))
          return value === null ? null : scalar ? value : JSON.stringify(value)
        }
        return Array.from({ length: table.starts.length - 1 }, (_, i) =>
          chunkOf(
            type,
            Array.from({ length: table.starts[i + 1]! - table.starts[i]! }, (_, at) =>
              cell(table.starts[i]! + at),
            ),
          ),
        )
      })
      columns.set(name, {
        type,
        starts: table.starts,
        get chunks() {
          return decode()
        },
      })
      plans.push({
        name,
        source: { kind: 'found', path: members[0]!.path, json: !scalar },
        definition: {
          type,
          nullable: true,
          description: "Not in GridKit Studio's catalog; kept as written.",
        },
      })
      firsts.push({
        type: shape.type,
        field: name,
        row: rows.get(members[0]!.first + members[0]!.record)!,
      })
    }
    tables.set(shape.type, { ...table, shape: withFound(table.shape, plans), fields: columns })
  }
  return firsts
}

/** The Case table's one row: the header's and system parameters' members. */
function caseTable(
  file: Uint8Array,
  layout: Layout,
  shape: Shape,
  version: Index['version'],
): Table {
  const values = new Map<string, Value>()
  /** The fields the file writes a value for, whether or not it reads as one. */
  const supplied = new Set<string>()
  const members = new Members()
  for (const member of layout.members) {
    if ((member.name !== 'header' && member.name !== 'params') || file[member.value] !== 0x7b)
      continue
    const kind = member.name === 'header' ? 'header' : 'parameter'
    const fields = new Map(
      shape.fields.flatMap((field) =>
        field.source.kind === kind ? [[field.source.name, field] as const] : [],
      ),
    )
    const count = members.read(file, member.value)
    const spans = members.spans
    for (let m = 0; m < count; m++) {
      const key = jsonText(file, spans[4 * m]!, spans[4 * m + 1]!)
      const field = fields.get(key)
      if (field === undefined) continue
      const value: unknown = JSON.parse(utf8(file, spans[4 * m + 2]!, spans[4 * m + 3]!))
      if (value !== null) supplied.add(field.name)
      // As a record's field reads its value: a number finite, and whole within range for an int32.
      const type = field.definition.type
      if (
        type === 'text'
          ? typeof value === 'string'
          : typeof value === 'number' &&
            Number.isFinite(value) &&
            (type !== 'int32' || isInt32(value))
      )
        values.set(field.name, value as Value)
    }
  }
  const starts = Uint32Array.of(0, 1)
  /** A column of the one row's `value`, wrong when the file writes one that does not read. */
  const column = (type: Schema.FieldType, value: Value, given = value !== null): Column => ({
    type,
    chunks: [chunkOf(type, [value])],
    starts,
    wrong: () => (given && value === null ? [0] : []),
  })
  return {
    shape,
    index: { source: version, type: CASE, version },
    starts,
    ids: column('text', CASE_ROW),
    fields: new Map(
      shape.fields.map((field) => [
        field.name,
        column(field.definition.type, values.get(field.name) ?? null, supplied.has(field.name)),
      ]),
    ),
    records: new Uint32Array(1),
  }
}

function startsOf(chunks: readonly Chunk[]): Uint32Array {
  const starts = new Uint32Array(chunks.length + 1)
  chunks.forEach((chunk, i) => (starts[i + 1] = starts[i]! + chunk.length))
  return starts
}

function concatenated(parts: readonly Uint32Array[]): Uint32Array {
  const out = new Uint32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A port's native numbers as rows of `target`; a number no row holds is null. Its wrong rows are
 *  those that write what is no number, and those whose number names no row: found again each
 *  revision, as the target's ids are read again. */
function references(native: readonly IndexedChunk[], starts: Uint32Array, target: Table): Column {
  const ids = native.length === 0 ? undefined : numberIds(target)
  const decode = deferred(() => {
    const wrong: number[] = []
    const chunks = native.map((source, c): Chunk.Reference => {
      const port = source.read() as Chunk.Numeric
      const values = new Uint32Array(port.length)
      let validity: Uint8Array | undefined
      const dangling: number[] = []
      for (let at = 0; at < port.length; at++) {
        const written = isValid(port, at)
        const row = written ? ids!.row(port.values[port.offset + at]!) : -1
        if (row >= 0) values[at] = row
        else {
          validity ??= new Uint8Array(Math.ceil(port.length / 8)).fill(0xff)
          validity[at >>> 3]! &= ~(1 << (at & 7))
          if (written) dangling.push(at)
        }
      }
      for (const at of [...source.wrong(), ...dangling].sort((a, b) => a - b))
        wrong.push(starts[c]! + at)
      return {
        kind: 'reference',
        index: target.index,
        values,
        offset: 0,
        length: port.length,
        ...(validity && { validity }),
      }
    })
    return { chunks, wrong }
  })
  return {
    type: { kind: 'reference', to: target.index.type },
    index: target.index,
    starts,
    get chunks() {
      return decode().chunks
    },
    wrong: () => decode().wrong,
  }
}

/** Every table's static fields as one Data, sharing the parsed chunks; an empty table keeps its
 *  columns. Row IDs are built on first read, so a view of fields alone never pays for them. */
function dataOf(schema: Schema, tables: ReadonlyMap<string, Table>): Data {
  const batches: Data.RowBatch[] = []
  for (const table of tables.values())
    batches.push({
      kind: 'rows',
      index: table.index,
      rows: { kind: 'range', offset: 0, count: rowCount(table.starts) },
      columns: {},
    })
  const base = createData(schema, batches)
  return {
    schema,
    tables: Object.fromEntries(
      Object.entries(base.tables).map(([type, empty]) => {
        const table = tables.get(type)!
        const fields: Record<string, Data.Pages> = { ...empty.fields }
        const pages = (name: string, column: Column): Data.Pages =>
          createData(
            schema,
            column.chunks.length === 0
              ? [
                  {
                    kind: 'rows',
                    index: table.index,
                    rows: empty.rows,
                    columns: { [name]: builder(column.type, column.index).finish() },
                  },
                ]
              : column.chunks.map((chunk, i): Data.RowBatch => ({
                  kind: 'rows',
                  index: table.index,
                  rows: { kind: 'range', offset: table.starts[i]!, count: chunk.length },
                  columns: { [name]: chunk },
                })),
          ).tables[type]!.fields[name]!
        for (const [name, definition] of Object.entries(schema.types[type]!.fields)) {
          if (definition.sampled) continue
          const column = name === table.shape.identity.name ? table.ids : table.fields.get(name)!
          Object.defineProperty(fields, name, {
            enumerable: true,
            get: deferred(() => pages(name, column)),
          })
        }
        const ids = deferred(() => {
          if (!table.ids.chunks.length) return empty.ids
          const prefix = UTF8.encode(`${type}/`)
          return createData(
            schema,
            table.ids.chunks.map((chunk, i): Data.RowBatch => ({
              kind: 'rows',
              index: table.index,
              rows: { kind: 'range', offset: table.starts[i]!, count: chunk.length },
              columns: {},
              ids: idsOf(prefix, chunk),
            })),
          ).tables[type]!.ids
        })
        return [
          type,
          {
            ...empty,
            fields,
            get ids() {
              return ids()
            },
          },
        ]
      }),
    ),
  }
}

/** The `Type/native` IDs of each chunk of native identities, made once: a range a revision keeps
 *  keeps its chunks, and so its IDs. */
const ids = new WeakMap<Chunk, Chunk.Text>()
function idsOf(prefix: Uint8Array, native: Chunk): Chunk.Text {
  let made = ids.get(native)
  if (!made) ids.set(native, (made = idColumn(prefix, native)))
  return made
}

/** `Type/native` IDs written straight into UTF-8, with no string per row. No identity is null. */
function idColumn(prefix: Uint8Array, native: Chunk): Chunk.Text {
  const count = native.length
  const offsets = new Int32Array(count + 1)
  let bytes: Uint8Array
  let at = 0
  if (native.kind === 'text') {
    const from = native.offset
    bytes = new Uint8Array(
      count * prefix.length + native.offsets[from + count]! - native.offsets[from]!,
    )
    for (let i = 0; i < count; i++) {
      const start = native.offsets[from + i]!
      const end = native.offsets[from + i + 1]!
      bytes.set(prefix, at)
      bytes.set(native.bytes.subarray(start, end), at + prefix.length)
      offsets[i + 1] = at += prefix.length + end - start
    }
  } else {
    const { values, offset } = native as Chunk.Numeric
    // A uint32 has at most ten digits.
    bytes = new Uint8Array(count * (prefix.length + 10))
    for (let i = 0; i < count; i++) {
      bytes.set(prefix, at)
      offsets[i + 1] = at = decimal(values[offset + i]!, bytes, at + prefix.length)
    }
    bytes = bytes.slice(0, at)
  }
  return { kind: 'text', bytes, offsets, offset: 0, length: count }
}

/** Writes a uint32's decimal digits at `at`; returns where they end. */
function decimal(value: number, bytes: Uint8Array, at: number): number {
  let end = at + 1
  for (let rest = value; rest >= 10; rest = Math.floor(rest / 10)) end++
  for (let i = end, rest = value; i > at; rest = Math.floor(rest / 10))
    bytes[--i] = 48 + (rest % 10)
  return end
}

// Identity indexes, built on first lookup: hash tables of UTF-8 text; direct or sorted numbers.

const TEXT = new WeakMap<Column, TextIds>()
const NUMBER = new WeakMap<Column, NumberIds>()

/** What a failure to index `table` says of its row `row`, which repeats an id: the record it is,
 *  as a parse problem names one. */
const repeated = (table: Table, row: number) =>
  table.shape.array === null
    ? {}
    : ({ target: { kind: 'path', path: [table.shape.array, table.records[row]!] } } as const)

function textIds(table: Table): TextIds {
  let ids = TEXT.get(table.ids)
  if (ids === undefined) TEXT.set(table.ids, (ids = new TextIds(table)))
  return ids
}

function numberIds(table: Table): NumberIds {
  let ids = NUMBER.get(table.ids)
  if (ids === undefined) NUMBER.set(table.ids, (ids = new NumberIds(table)))
  return ids
}

class TextIds {
  /** Row + 1 per slot, 0 empty; a power of two, at most half full. */
  readonly #slots: Uint32Array
  readonly #column: Column

  constructor(table: Table) {
    const column = (this.#column = table.ids)
    let size = 16
    while (size < rowCount(column.starts) * 2) size *= 2
    const slots = new Uint32Array(size)
    const mask = size - 1
    column.chunks.forEach((value, index) => {
      const chunk = value as Chunk.Text
      const first = column.starts[index]!
      for (let at = 0; at < chunk.length; at++) {
        if (!isValid(chunk, at)) continue
        const start = chunk.offsets[chunk.offset + at]!
        const end = chunk.offsets[chunk.offset + at + 1]!
        let slot = hash(chunk.bytes, start, end) & mask
        while (slots[slot] !== 0) {
          if (this.#equals(slots[slot]! - 1, chunk.bytes, start, end))
            throw failure(
              'invalid-input',
              `Two rows share the id ${utf8(chunk.bytes, start, end)}.`,
              repeated(table, first + at),
            )
          slot = (slot + 1) & mask
        }
        slots[slot] = first + at + 1
      }
    })
    this.#slots = slots
  }

  /** The row holding `id`, or -1. */
  row(id: string): number {
    const key = Buffer.from(id, 'utf8')
    const mask = this.#slots.length - 1
    for (
      let slot = hash(key, 0, key.length) & mask;
      this.#slots[slot] !== 0;
      slot = (slot + 1) & mask
    ) {
      const row = this.#slots[slot]! - 1
      if (this.#equals(row, key, 0, key.length)) return row
    }
    return -1
  }

  #equals(row: number, bytes: Uint8Array, start: number, end: number): boolean {
    const index = chunkAt(this.#column.starts, row)
    const chunk = this.#column.chunks[index] as Chunk.Text
    const at = chunk.offset + row - this.#column.starts[index]!
    const from = chunk.offsets[at]!
    if (chunk.offsets[at + 1]! - from !== end - start) return false
    for (let i = 0; i < end - start; i++)
      if (chunk.bytes[from + i] !== bytes[start + i]) return false
    return true
  }
}

class NumberIds {
  /** Dense: row + 1 at key - min. Sparse: sorted keys and their rows. */
  readonly #min: number
  readonly #dense: Uint32Array | null
  readonly #keys: Uint32Array
  readonly #rows: Uint32Array

  constructor(table: Table) {
    const column = table.ids
    const count = rowCount(column.starts)
    const keys = new Uint32Array(count)
    const rows = new Uint32Array(count)
    let size = 0
    let min = 0xffffffff
    let max = 0
    column.chunks.forEach((value, index) => {
      const chunk = value as Chunk.Numeric
      for (let at = 0; at < chunk.length; at++) {
        if (!isValid(chunk, at)) continue
        const key = chunk.values[chunk.offset + at]!
        keys[size] = key
        rows[size++] = column.starts[index]! + at
        if (key < min) min = key
        if (key > max) max = key
      }
    })
    this.#min = min
    const duplicate = (key: number, row: number): never => {
      throw failure('invalid-input', `Two rows share the number ${key}.`, repeated(table, row))
    }
    if (size > 0 && max - min < 4 * size + 64) {
      const dense = new Uint32Array(max - min + 1)
      for (let i = 0; i < size; i++) {
        if (dense[keys[i]! - min] !== 0) duplicate(keys[i]!, rows[i]!)
        dense[keys[i]! - min] = rows[i]! + 1
      }
      this.#dense = dense
      this.#keys = this.#rows = new Uint32Array(0)
      return
    }
    const order = radixOrder(keys.subarray(0, size))
    this.#dense = null
    this.#keys = new Uint32Array(size)
    this.#rows = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      this.#keys[i] = keys[order[i]!]!
      this.#rows[i] = rows[order[i]!]!
      if (i > 0 && this.#keys[i] === this.#keys[i - 1])
        duplicate(this.#keys[i]!, Math.max(this.#rows[i]!, this.#rows[i - 1]!))
    }
  }

  /** The row holding `key`, or -1. */
  row(key: number): number {
    if (this.#dense !== null) {
      const at = key - this.#min
      return at >= 0 && at < this.#dense.length ? this.#dense[at]! - 1 : -1
    }
    let low = 0
    let high = this.#keys.length - 1
    while (low <= high) {
      const middle = (low + high) >>> 1
      const found = this.#keys[middle]!
      if (found === key) return this.#rows[middle]!
      if (found < key) low = middle + 1
      else high = middle - 1
    }
    return -1
  }
}
