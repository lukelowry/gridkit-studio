/** A loaded case: its tables as column chunks, the Data a host reads, and the file a run's case file is written from. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { setImmediate } from 'node:timers/promises'

import type {
  ColumnPages,
  Data,
  DataType,
  Index,
  NumericColumn,
  ReferenceColumn,
  RowBatch,
  Schema,
  TextColumn,
  Value,
  Version,
} from '@latkit/model'
import { createData, failure } from '@latkit/model'
import { printParseErrorCode, visit } from 'jsonc-parser'

import {
  builder,
  type Chunk,
  chunkAt,
  chunkOf,
  type Column,
  isValid,
  radixOrder,
  rowCount,
  utf8,
  valueAt,
} from './columns.js'
import { type ArrayName, CASE, CASE_ROW, type Catalog, type Shape, SIGNAL } from './definition.js'
import {
  ARRAYS,
  type Layout,
  Members,
  NONE,
  type Parsed,
  Parser,
  type Range,
  type Records,
  scan,
} from './parse.js'

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

/** One array in the file: its records, and each one's `mon` value as a start and end, 0, 0 where it has none. */
export interface RecordArray extends Records {
  readonly mons: Uint32Array
}

const RANGE_BYTES = 256 << 10
const UTF8 = new TextEncoder()

export class Case {
  #signalsChecked = false
  #data: Data | undefined

  /** The case at `path`. Large files are parsed in parallel ranges of about 8 MB. Small files avoid worker
   *  startup. Column chunks join their tables in file order without a copy. */
  static async read(path: string, catalog: Catalog, signal?: AbortSignal): Promise<Case> {
    return Case.parse(await readFile(path, 'utf8'), catalog, basename(path, '.case.json'), signal)
  }

  static async parse(
    text: string,
    catalog: Catalog,
    name = 'Case',
    signal?: AbortSignal,
  ): Promise<Case> {
    signal?.throwIfAborted()
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
          throw Object.assign(failure('invalid-input', printParseErrorCode(error)), {
            offset,
            length,
          })
        },
      },
      { disallowComments: true, allowTrailingComma: false },
    )
    const file = new TextEncoder().encode(text)
    const layout = scan(file)
    const ranges = rangesOf(layout)
    const parsed = await parseAll(file, ranges, catalog, signal)
    const version = createHash('sha256')
      .update(catalog.text)
      .update(file)
      .digest('hex')
      .slice(0, 32)
    const kase = joined(parsed, ranges, file, layout, catalog, version, name)
    // Force identity indexes here: duplicate native IDs must fail before publishing a projection.
    for (const table of kase.tables.values()) {
      if (table.shape.identity.type === 'text') textIds(table.ids)
      else numberIds(table.ids)
    }
    return kase
  }
  constructor(
    readonly name: string,
    readonly version: Version,
    readonly catalog: Catalog,
    readonly tables: ReadonlyMap<string, Table>,
    /** The file as read; a simulation's case file is written from it. */
    readonly file: Uint8Array,
    readonly arrays: Readonly<Partial<Record<ArrayName, RecordArray>>>,
    /** The top-level object's closing brace. */
    readonly close: number,
  ) {}

  /** Every static field and row ID, as a host reads them. Assembled on first read rather than while the parse's
   *  buffers are still live, which keeps the load's memory high-water mark, and so the process's peak, down. */
  get data(): Data {
    return (this.#data ??= dataOf(this.catalog.schema, this.tables))
  }

  get schema(): Schema {
    return this.catalog.schema
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
      : (ids as NumericColumn).values[i]!
  }

  /** The row with this native identity, or -1. */
  rowOf(table: Table, native: string | number): number {
    if (table.shape.identity.type === 'text')
      return typeof native === 'string' ? textIds(table.ids).row(native) : -1
    const number =
      typeof native === 'number' ? native : /^(0|[1-9][0-9]*)$/.test(native) ? Number(native) : -1
    return number >= 0 && number <= 0xffffffff ? numberIds(table.ids).row(number) : -1
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

  /** Before simulation, reject signals driven by more than one output port. */
  checkSignals(): void {
    if (this.#signalsChecked) return
    const signals = this.table(SIGNAL)
    const driven = new Uint8Array(Math.ceil(rowCount(signals.starts) / 8))
    for (const table of this.tables.values())
      for (const port of table.shape.ports) {
        if (port.definition.type.to !== SIGNAL || port.definition.direction !== 'out') continue
        for (const chunk of table.fields.get(port.name)!.chunks) {
          const reference = chunk as ReferenceColumn
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

/** Each array's records, cut at record boundaries into ranges of about RANGE_BYTES. */
function rangesOf(layout: Layout): Range[] {
  const ranges: Range[] = []
  for (const array of ARRAYS) {
    const records = layout.arrays[array]
    if (records === undefined) continue
    const { starts, ends } = records
    for (let first = 0; first < starts.length;) {
      let last = first + 1
      while (last < starts.length && ends[last]! - starts[first]! < RANGE_BYTES) last++
      ranges.push({ array, first, starts: starts.subarray(first, last) })
      first = last
    }
  }
  return ranges
}

/** Runs inside Studio's single data worker. Yield between bounded ranges for cancellation. */
async function parseAll(
  bytes: Uint8Array,
  ranges: readonly Range[],
  catalog: Catalog,
  signal?: AbortSignal,
): Promise<Parsed[]> {
  const parser = new Parser(catalog)
  const parsed: Parsed[] = []
  for (const range of ranges) {
    signal?.throwIfAborted()
    parsed.push(parser.parse(bytes, range.array, range.first, range.starts))
    await setImmediate()
  }
  const problems = parsed.flatMap((range) => range.problems)
  if (problems.length)
    throw failure('invalid-input', problems[0]!.message, { issues: problems.slice(0, 100) })
  return parsed
}
/** The parsed ranges as one case: each table's chunks in file order, its ports resolved, and each record's place. */
function joined(
  parsed: readonly Parsed[],
  ranges: readonly Range[],
  file: Uint8Array,
  layout: Layout,
  catalog: Catalog,
  version: Version,
  fallback: string,
): Case {
  const chunks = catalog.codes.map((shape) => ({
    ids: [] as Chunk[],
    fields: shape.fields.map((): Chunk[] => []),
    ports: shape.ports.map((): Chunk[] => []),
  }))
  const records = catalog.codes.map((): number[] => [])
  const mons = new Map<ArrayName, Uint32Array[]>()
  ranges.forEach((range, r) => {
    const { tables, codes, mons: spans } = parsed[r]!
    for (let i = 0; i < codes.length; i++)
      if (codes[i] !== NONE) records[codes[i]!]!.push(range.first + i)
    tables.forEach((table, code) => {
      if (table === null) return
      const into = chunks[code]!
      into.ids.push(...table.ids)
      table.fields.forEach((field, i) => into.fields[i]!.push(...field))
      table.ports.forEach((port, i) => into.ports[i]!.push(...port))
    })
    mons.set(range.array, [...(mons.get(range.array) ?? []), spans])
  })
  const tables = new Map<string, Table>()
  const index = (type: string): Index => ({ source: version, type, version })
  catalog.codes.forEach((shape, code) => {
    const { ids, fields } = chunks[code]!
    const starts = startsOf(ids)
    const column = (type: DataType, list: readonly Chunk[]): Column => ({
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
        shape.fields.map((field, i) => [field.name, column(field.definition.type, fields[i]!)]),
      ),
      records: Uint32Array.from(records[code]!),
    })
  })
  // Ports become references once every table they can name is in place.
  catalog.codes.forEach((shape, code) => {
    const table = tables.get(shape.type)!
    shape.ports.forEach((port, i) => {
      const target = tables.get(port.definition.type.to)!
      ;(table.fields as Map<string, Column>).set(
        port.name,
        references(chunks[code]!.ports[i]!, table.starts, target),
      )
    })
  })
  const header = caseTable(file, layout, catalog.shapes.get(CASE)!, version)
  tables.set(CASE, header)
  const arrays: Partial<Record<ArrayName, RecordArray>> = {}
  for (const array of ARRAYS) {
    const spans = layout.arrays[array]
    if (spans !== undefined) arrays[array] = { ...spans, mons: concatenated(mons.get(array) ?? []) }
  }
  const name = valueAt(header.fields.get('name')!.chunks[0]!, 0)
  return new Case(
    typeof name === 'string' && name !== '' ? name : fallback,
    version,
    catalog,
    tables,
    file,
    arrays,
    layout.close,
  )
}

/** The Case table's one row: the header's and system parameters' members it knows. */
function caseTable(file: Uint8Array, layout: Layout, shape: Shape, version: Version): Table {
  const values = new Map<string, Value>()
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
      const key = utf8(file, spans[4 * m]!, spans[4 * m + 1]!)
      const field = fields.get(key)
      if (field === undefined) continue
      const value: unknown = JSON.parse(utf8(file, spans[4 * m + 2]!, spans[4 * m + 3]!))
      const text = field.definition.type === 'text'
      if (text ? typeof value === 'string' : typeof value === 'number')
        values.set(field.name, value as Value)
    }
  }
  const starts = Uint32Array.of(0, 1)
  const column = (type: DataType, value: Value): Column => ({
    type,
    chunks: [chunkOf(type, [value])],
    starts,
  })
  return {
    shape,
    index: { source: version, type: CASE, version },
    starts,
    ids: column('text', CASE_ROW),
    fields: new Map(
      shape.fields.map((field) => [
        field.name,
        column(field.definition.type, values.get(field.name) ?? null),
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

/** A port's native numbers as rows of `target`; a number no row holds is null. */
function references(native: readonly Chunk[], starts: Uint32Array, target: Table): Column {
  const ids = native.length === 0 ? undefined : numberIds(target.ids)
  return {
    type: { kind: 'reference', to: target.index.type },
    index: target.index,
    starts,
    chunks: native.map((source): ReferenceColumn => {
      const port = source as NumericColumn
      const values = new Uint32Array(port.length)
      let validity: Uint8Array | undefined
      for (let at = 0; at < port.length; at++) {
        const row = isValid(port, at) ? ids!.row(port.values[port.offset + at]!) : -1
        if (row >= 0) values[at] = row
        else {
          validity ??= new Uint8Array(Math.ceil(port.length / 8)).fill(0xff)
          validity[at >>> 3]! &= ~(1 << (at & 7))
        }
      }
      return {
        kind: 'reference',
        index: target.index,
        values,
        offset: 0,
        length: port.length,
        ...(validity && { validity }),
      }
    }),
  }
}

/** Every table's static fields as one Data, sharing the parsed chunks. An empty table keeps its columns. Row IDs are
 *  written when first read: a view watching fields alone never pays for them. */
function dataOf(schema: Schema, tables: ReadonlyMap<string, Table>): Data {
  const batches: RowBatch[] = []
  for (const [type, table] of tables) {
    const statics = Object.entries(schema.types[type]!.fields).flatMap(([name, definition]) =>
      definition.sampled
        ? []
        : [
            [
              name,
              name === table.shape.identity.name ? table.ids : table.fields.get(name)!,
            ] as const,
          ],
    )
    const count = table.starts.length - 1
    if (count === 0)
      batches.push({
        kind: 'rows',
        index: table.index,
        rows: { kind: 'range', offset: 0, count: 0 },
        columns: Object.fromEntries(
          statics.map(([name, column]) => [name, builder(column.type, column.index).finish()]),
        ),
      })
    for (let i = 0; i < count; i++)
      batches.push({
        kind: 'rows',
        index: table.index,
        rows: {
          kind: 'range',
          offset: table.starts[i]!,
          count: table.starts[i + 1]! - table.starts[i]!,
        },
        columns: Object.fromEntries(statics.map(([name, column]) => [name, column.chunks[i]!])),
      })
  }
  const data = createData(schema, batches)
  return {
    schema,
    tables: Object.fromEntries(
      Object.entries(data.tables).map(([type, fields]) => {
        const table = tables.get(type)!
        const prefix = UTF8.encode(`${type}/`)
        let ids: ColumnPages | undefined
        return [
          type,
          {
            ...fields,
            get ids() {
              return (ids ??=
                table.ids.chunks.length === 0
                  ? fields.ids
                  : createData(
                      schema,
                      table.ids.chunks.map((chunk, i): RowBatch => ({
                        kind: 'rows',
                        index: table.index,
                        rows: { kind: 'range', offset: table.starts[i]!, count: chunk.length },
                        columns: {},
                        ids: idColumn(prefix, chunk),
                      })),
                    ).tables[type]!.ids)
            },
          },
        ]
      }),
    ),
  }
}

/** `Type/native` IDs written straight into UTF-8, without a string per row. A loaded case has no null identity. */
function idColumn(prefix: Uint8Array, native: Chunk): TextColumn {
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
    const { values, offset } = native as NumericColumn
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

// Identity indexes, built on first lookup: UTF-8 hash tables for text, direct or sorted indexes for numbers.
const TEXT = new WeakMap<Column, TextIds>()
const NUMBER = new WeakMap<Column, NumberIds>()

function textIds(column: Column): TextIds {
  let ids = TEXT.get(column)
  if (ids === undefined) TEXT.set(column, (ids = new TextIds(column)))
  return ids
}

function numberIds(column: Column): NumberIds {
  let ids = NUMBER.get(column)
  if (ids === undefined) NUMBER.set(column, (ids = new NumberIds(column)))
  return ids
}

function hash(bytes: Uint8Array, start: number, end: number): number {
  let h = 0x811c9dc5
  for (let i = start; i < end; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return h >>> 0
}

class TextIds {
  /** Row + 1 per slot, 0 empty; a power of two, at most half full. */
  readonly #slots: Uint32Array
  readonly #column: Column

  constructor(column: Column) {
    this.#column = column
    let size = 16
    while (size < rowCount(column.starts) * 2) size *= 2
    const slots = new Uint32Array(size)
    const mask = size - 1
    column.chunks.forEach((value, index) => {
      const chunk = value as TextColumn
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
    const chunk = this.#column.chunks[index] as TextColumn
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

  constructor(column: Column) {
    const count = rowCount(column.starts)
    const keys = new Uint32Array(count)
    const rows = new Uint32Array(count)
    let size = 0
    let min = 0xffffffff
    let max = 0
    column.chunks.forEach((value, index) => {
      const chunk = value as NumericColumn
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
    const duplicate = (key: number): never => {
      throw failure('invalid-input', `Two rows share the number ${key}.`)
    }
    if (size > 0 && max - min < 4 * size + 64) {
      const dense = new Uint32Array(max - min + 1)
      for (let i = 0; i < size; i++) {
        if (dense[keys[i]! - min] !== 0) duplicate(keys[i]!)
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
      if (i > 0 && this.#keys[i] === this.#keys[i - 1]) duplicate(this.#keys[i]!)
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
