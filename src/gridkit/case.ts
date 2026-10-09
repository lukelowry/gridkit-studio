/** A loaded case: its tables as column chunks, the Data a host reads, and the file as read. */

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
  TypeDefinition,
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
  deferred,
  hash,
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
import {
  ARRAYS,
  type Found,
  type IndexedChunk,
  type Layout,
  type Member,
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

/** A field the catalog does not know, and the first row that has it. */
export interface FoundField {
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
    const file = UTF8.encode(text)
    const layout = scan(file)
    const ranges = rangesOf(layout)
    const { parsed, shapes } = await parseAll(file, ranges, catalog, signal)
    const version = createHash('sha256')
      .update(catalog.text)
      .update(file)
      .digest('hex')
      .slice(0, 32)
    const kase = joined(parsed, shapes, ranges, file, layout, catalog, version, name)
    // Build the identity indexes here, so duplicate IDs fail the parse.
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
    /** The catalog's types, with the classes and fields this case has that it does not know. */
    readonly schema: Schema,
    readonly tables: ReadonlyMap<string, Table>,
    /** The file as read. */
    readonly file: Uint8Array,
    readonly arrays: Readonly<Partial<Record<ArrayName, RecordArray>>>,
    /** The top-level object's closing brace. */
    readonly close: number,
    /** The case's own `monitors` member: where GridKit writes what the case records. */
    readonly monitors: Member | undefined,
    /** Every field the catalog does not know, where it is first. */
    readonly found: readonly FoundField[],
  ) {}

  /** One immutable Data facade. Each field and row-ID column decodes on its first read. */
  get data(): Data {
    return (this.#data ??= dataOf(this.schema, this.tables))
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

  /** Throws when more than one output port drives a signal. */
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

/** Parses range by range, yielding between ranges so `signal` can cancel; returns every table's
 *  shape by code, the classes found included. */
async function parseAll(
  bytes: Uint8Array,
  ranges: readonly Range[],
  catalog: Catalog,
  signal?: AbortSignal,
): Promise<{ parsed: Parsed[]; shapes: readonly Shape[] }> {
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
  return { parsed, shapes: parser.shapes }
}

/** The parsed ranges as one case: chunks joined in file order, ports resolved, records placed. */
function joined(
  parsed: readonly Parsed[],
  shapes: readonly Shape[],
  ranges: readonly Range[],
  file: Uint8Array,
  layout: Layout,
  catalog: Catalog,
  version: Version,
  fallback: string,
): Case {
  const chunks = shapes.map((shape) => ({
    ids: [] as Chunk[],
    fields: shape.fields.map((): IndexedChunk[] => []),
    ports: shape.ports.map((): IndexedChunk[] => []),
  }))
  const records = shapes.map((): number[] => [])
  const found: (Found & { readonly first: number })[] = []
  const mons = new Map<ArrayName, Uint32Array[]>()
  ranges.forEach((range, r) => {
    const { tables, codes, mons: spans } = parsed[r]!
    for (let i = 0; i < codes.length; i++)
      if (codes[i] !== NONE) records[codes[i]!]!.push(range.first + i)
    for (const member of parsed[r]!.found) found.push({ ...member, first: range.first })
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
  shapes.forEach((shape, code) => {
    const { ids, fields } = chunks[code]!
    const decoded = fields.map((parts) => deferred(() => parts.map((part) => part.read())))
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
        shape.fields.map((field, i) => [
          field.name,
          {
            type: field.definition.type,
            starts,
            get chunks() {
              return decoded[i]!()
            },
            supplied: (row: number) => {
              const chunk = chunkAt(starts, row)
              return fields[i]![chunk]!.supplied(row - starts[chunk]!)
            },
          },
        ]),
      ),
      records: Uint32Array.from(records[code]!),
    })
  })
  // Ports become references once every table they can name is in place.
  shapes.forEach((shape, code) => {
    const table = tables.get(shape.type)!
    shape.ports.forEach((port, i) => {
      const target = tables.get(port.definition.type.to)!
      ;(table.fields as Map<string, Column>).set(
        port.name,
        references(chunks[code]!.ports[i]!, table.starts, target),
      )
    })
  })
  const fields = foundColumns(file, found, records, shapes, tables)
  const header = caseTable(file, layout, catalog.shapes.get(CASE)!, version)
  tables.set(CASE, header)
  const types: Record<string, TypeDefinition> = Object.create(null)
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
    layout.members.find((member) => member.name === 'monitors'),
    fields,
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
    const name = member.path.join('.')
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
      // allocating strings or parsing unrelated extension objects on the opening path.
      const kinds = new Set(
        members.map(({ value }) => {
          const first = file[value]!
          return first === 0x22
            ? 'string'
            : first === 0x74 || first === 0x66
              ? 'boolean'
              : first === 0x2d || (first >= 0x30 && first <= 0x39)
                ? 'number'
                : 'object'
        }),
      )
      const scalar = kinds.size === 1 && !kinds.has('object')
      const type: DataType = !scalar
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
function references(native: readonly IndexedChunk[], starts: Uint32Array, target: Table): Column {
  const ids = native.length === 0 ? undefined : numberIds(target.ids)
  const decode = deferred(() =>
    native.map((source): ReferenceColumn => {
      const port = source.read() as NumericColumn
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
  )
  return {
    type: { kind: 'reference', to: target.index.type },
    index: target.index,
    starts,
    get chunks() {
      return decode()
    },
    supplied(row) {
      const chunk = chunkAt(starts, row)
      return native[chunk]!.supplied(row - starts[chunk]!)
    },
  }
}

/** Every table's static fields as one Data, sharing the parsed chunks; an empty table keeps its
 *  columns. Row IDs are built on first read, so a view of fields alone never pays for them. */
function dataOf(schema: Schema, tables: ReadonlyMap<string, Table>): Data {
  const batches: RowBatch[] = []
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
        const fields: Record<string, ColumnPages> = { ...empty.fields }
        const pages = (name: string, column: Column): ColumnPages =>
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
              : column.chunks.map((chunk, i): RowBatch => ({
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
            table.ids.chunks.map((chunk, i): RowBatch => ({
              kind: 'rows',
              index: table.index,
              rows: { kind: 'range', offset: table.starts[i]!, count: chunk.length },
              columns: {},
              ids: idColumn(prefix, chunk),
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

/** `Type/native` IDs written straight into UTF-8, with no string per row. No identity is null. */
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

// Identity indexes, built on first lookup: hash tables of UTF-8 text; direct or sorted numbers.
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
