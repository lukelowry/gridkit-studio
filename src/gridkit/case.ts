/** A loaded case: its tables as column chunks, what views project of them, and the file as read. */
import { createHash } from 'node:crypto'

import { printParseErrorCode, visit } from 'jsonc-parser'
import { type Id, reference } from 'latkit'

import type { CaseDefinition, Entity } from '../shared/document.js'
import { LABEL, NETWORK_POSITION } from '../shared/document.js'
import type { SourceError, SourceProblem } from '../shared/errors.js'
import { problem } from '../shared/errors.js'
import type { Value } from '../shared/messages.js'
import {
  type Chunk,
  chunkAt,
  chunkOf,
  type Column,
  type DecodeKind,
  deferred,
  isInt32,
  isUint32,
  isValid,
  radixOrder,
  readColumn,
  rowCount,
  utf8,
  valueAt,
} from './columns.js'
import {
  type ArrayName,
  CASE,
  CASE_ROW,
  type Catalog,
  definitionsOf,
  type FieldPlan,
  type Shape,
  SIGNAL,
  withFound,
} from './definition.js'
import type { ProjectedDocument, ProjectedTable } from './document.js'
import { charsAt } from './offsets.js'
import {
  ARRAYS,
  type Coding,
  type Found,
  type IndexedChunk,
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
  scan,
} from './parse.js'
import { Turns } from './turns.js'

export interface Table {
  readonly shape: Shape
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
/** What a case keeps alive per byte of its source, and per field and per record of its tables. */
const SOURCE_BYTES = 4
const FIELD_BYTES = 24
const RECORD_BYTES = 80

export class Case {
  #signalsChecked = false
  #projection?: ProjectedDocument

  /** The case `file` holds, its UTF-8 bytes, parsed in ranges of about 256 KiB whose column chunks
   *  join their tables in file order without a copy. */
  static async parse(
    file: Uint8Array,
    catalog: Catalog,
    name = 'Case',
    signal?: AbortSignal,
  ): Promise<Case> {
    signal?.throwIfAborted()
    let layout: Layout
    try {
      layout = await scan(file, signal)
    } catch (error) {
      const byte = (error as { byte?: number }).byte
      if (byte === undefined) throw error
      // A file that is not JSON is read again the slower way, which says why as an editor does,
      // unless it nests deeper than that way reads.
      try {
        syntax(new TextDecoder().decode(file))
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
      // A record the parse refused, or the second of an id, says so where it is, as each other
      // record it refused does.
      const { target, problems } = error as SourceError & { problems?: readonly SourceProblem[] }
      if (target?.kind !== 'path') throw error
      const at = ({ path: [array, record] }: SourceProblem['target']) =>
        placeOf(file, layout.arrays[array as ArrayName], record)
      throw Object.assign(error as Error, at(target), {
        problems: problems?.flatMap(({ message, target }) => {
          const place = at(target)
          return place ? [{ message, ...place }] : []
        }),
      })
    }
  }

  constructor(
    readonly name: string,
    readonly version: string,
    readonly catalog: Catalog,
    /** The catalog's types, with the classes and fields this case has that it does not know. */
    readonly definition: CaseDefinition,
    readonly tables: ReadonlyMap<string, Table>,
    /** The file as read. */
    readonly file: Uint8Array,
    readonly arrays: Readonly<Partial<Record<ArrayName, RecordArray>>>,
    /** The case's own members, in file order: its header, params, arrays and monitors. */
    readonly members: readonly Member[],
    /** Every field GridKit reads that the catalog does not know, where it is first. An extension's
     *  members, whose keys GridKit's format leaves to each tool, are columns all the same. */
    readonly found: readonly FoundField[],
    /** The ranges its records were read in, and how their tables were coded. */
    readonly parts: readonly Part[],
    readonly coding: Coding,
  ) {}

  /** The case's own member `name`, as `monitors`, where GridKit writes what the case records. */
  member(name: string): Member | undefined {
    return this.members.find((member) => member.name === name)
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
    if (table === undefined) throw problem('invalid-input', `No type is called ${type}.`)
    return table
  }

  cell(table: Table, field: string, row: number): Value {
    const column = field === table.shape.identity.name ? table.ids : table.fields.get(field)
    if (column === undefined)
      throw problem('invalid-input', `${table.shape.type} has no field ${field}.`)
    const chunk = chunkAt(column.starts, row)
    return valueAt(column.chunks[chunk]!, row - column.starts[chunk]!)
  }

  /** A row's native identity, as the file writes it. */
  native(table: Table, row: number): string | number {
    const chunk = chunkAt(table.starts, row)
    return table.ids.chunks[chunk]![row - table.starts[chunk]!] as Id
  }

  /** The row with this native identity, or -1. */
  rowOf(table: Table, native: string | number): number {
    if (table.shape.identity.type === 'text')
      return typeof native === 'string' ? textIds(table).row(native) : -1
    return typeof native === 'number' && isUint32(native) ? numberIds(table).row(native) : -1
  }

  entity(table: Table, row: number): Entity {
    return { table: table.shape.type, id: this.native(table, row) }
  }

  locate(entity: Entity): { readonly table: Table; readonly row: number } | null {
    const table = this.tables.get(entity.table)
    const row = table ? this.rowOf(table, entity.id) : -1
    return row < 0 ? null : { table: table!, row }
  }

  projected(): ProjectedDocument {
    if (this.#projection) return this.#projection
    const tables = new Map<string, ProjectedTable>()
    for (const [name, table] of this.tables) {
      const ids = identities(table)
      tables.set(name, {
        ids,
        read: (field, offset, count) => {
          if (field === LABEL) return ids.slice(offset, offset + count).map(String)
          // Where no field places a vertex, the layout does.
          if (NETWORK_POSITION.includes(field)) return new Float64Array(count).fill(NaN)
          const column = field === table.shape.identity.name ? table.ids : table.fields.get(field)
          if (!column) throw problem('invalid-input', 'Unknown source field: ' + name + '.' + field)
          const values = readColumn(column, offset, count)
          return column.target
            ? reference(
                column.target,
                Array.from(values as Float64Array, (id) => (Number.isFinite(id) ? id : null)),
              )
            : values
        },
      })
    }
    return (this.#projection = { key: this.version, definition: this.definition, tables })
  }

  /** Throws when more than one output port drives a signal. */
  checkSignals(): void {
    if (this.#signalsChecked) return
    const signals = this.table(SIGNAL)
    const driven = new Uint8Array(Math.ceil(rowCount(signals.starts) / 8))
    for (const table of this.tables.values())
      for (const port of table.shape.ports) {
        if (port.definition.target !== SIGNAL || port.definition.direction !== 'out') continue
        for (const chunk of table.fields.get(port.name)!.chunks) {
          const reference = chunk as Float64Array
          for (let at = 0; at < reference.length; at++) {
            if (!isValid(reference, at)) continue
            const row = this.rowOf(signals, reference[at]!)
            const bit = 1 << (row & 7)
            if ((driven[row >>> 3]! & bit) !== 0) {
              const id = this.native(signals, row)
              throw problem('invalid-input', `${id} has more than one driver.`, {
                target: { kind: 'row', entity: { table: SIGNAL, id } },
              })
            }
            driven[row >>> 3]! |= bit
          }
        }
      }
    this.#signalsChecked = true
  }
}

/** A range of records as a case read it, and what was read of it. */
export interface Part {
  readonly range: Range
  readonly parsed: Parsed
}

/** The records of each array `layout` lays out, cut at record boundaries into ranges of about
 *  RANGE_BYTES. */
function rangesOf(layout: Layout): Range[] {
  return ARRAYS.flatMap((array) => {
    const records = layout.arrays[array]
    if (!records) return []
    const { starts, ends } = records
    const ranges: Range[] = []
    for (let from = 0; from < starts.length;) {
      let to = from + 1
      while (to < starts.length && ends[to]! - starts[from]! < RANGE_BYTES) to++
      ranges.push({ array, first: from, starts: starts.subarray(from, to) })
      from = to
    }
    return ranges
  })
}

/** `ranges` of `bytes` read by `parser`, range by range, in turns so `signal` can cancel. What a
 *  range refuses fails them all, saying where the first refusal is, and the first PROBLEMS in all. */
async function partsOf(
  bytes: Uint8Array,
  ranges: readonly Range[],
  parser: Parser,
  signal?: AbortSignal,
): Promise<Part[]> {
  const work = new Turns(signal)
  const parts: Part[] = []
  for (const range of ranges) {
    await work.step()
    parts.push({ range, parsed: parser.parse(bytes, range.array, range.first, range.starts) })
  }
  const problems = parts.flatMap(({ parsed }) => parsed.problems)
  const [first] = problems
  if (first)
    throw problem('invalid-input', first.message, {
      problems: problems.slice(0, PROBLEMS),
      target: first.target,
    })
  return parts
}

/** The fingerprint of a case read from `file` with `catalog`. */
const hashOf = (catalog: Catalog, file: Uint8Array): string =>
  createHash('sha256').update(catalog.text).update(file).digest('hex').slice(0, 32)

/** The case of `file`, as `layout` lays it out and `parts`, coded as `coding` says, read its
 *  records, of the fingerprint `version`; `name` names it when its header gives none. Its
 *  identity indexes are built, so an id two rows share fails it. */
function assembled(
  file: Uint8Array,
  layout: Layout,
  parts: readonly Part[],
  coding: Coding,
  catalog: Catalog,
  name: string,
  version: string,
): Case {
  const kase = joined(parts, coding, file, layout, catalog, version, name)
  for (const table of kase.tables.values())
    if (table.shape.identity.type === 'text') textIds(table)
    else numberIds(table)
  return kase
}

/** The parsed ranges as one case: chunks joined in file order, ports resolved, records placed. A
 *  class the catalog does not know that no record has any more has no table. */
function joined(
  parts: readonly Part[],
  coding: Coding,
  file: Uint8Array,
  layout: Layout,
  catalog: Catalog,
  version: string,
  fallback: string,
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
  for (const { range, parsed } of parts) {
    const { tables, codes } = parsed
    for (let i = 0; i < codes.length; i++)
      if (codes[i] !== NONE) records[codes[i]!]!.push(range.first + i)
    for (const member of parsed.found) found.push({ ...member, first: range.first })
    tables.forEach((table, code) => {
      if (table === null) return
      const into = chunks[code]!
      into.ids.push(...table.ids)
      table.fields.forEach((field, i) => into.fields[i]!.push(...field))
      table.ports.forEach((port, i) => into.ports[i]!.push(...port))
    })
    mons.set(range.array, [...(mons.get(range.array) ?? []), parsed.mons])
  }
  const tables = new Map<string, Table>()
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
    const column = (type: DecodeKind, list: readonly Chunk[]): Column => ({
      kind: type,
      chunks: list,
      starts,
    })
    tables.set(shape.type, {
      shape,
      starts,
      ids: column(shape.identity.type, ids),
      fields: new Map(
        shape.fields.map((field, i) => [
          field.name,
          {
            kind: field.decode,
            starts,
            provided: () => fields[i]!.some((part) => part.provided()),
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
      const target = tables.get(port.definition.target)!
      ;(table.fields as Map<string, Column>).set(
        port.name,
        references(chunks[code]!.ports[i]!, table.starts, target),
      )
    })
  }
  const fields = foundColumns(file, found, records, shapes, tables)
  const header = caseTable(file, layout, catalog.shapes.get(CASE)!)
  tables.set(CASE, header)
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
    definitionsOf(
      [...tables.values()].map((table) => table.shape),
      (table, field) => tables.get(table)?.fields.get(field)?.provided?.() ?? false,
    ),
    tables,
    file,
    arrays,
    layout.members,
    fields,
    parts,
    coding,
  )
}

/** Where record `record` of `records` lies in `file`. */
function placeOf(
  file: Uint8Array,
  records: Records | undefined,
  record: unknown,
): { offset: number; length: number } | undefined {
  if (!records || typeof record !== 'number' || !(record < records.starts.length)) return undefined
  const start = records.starts[record]!
  const offset = charsAt(file, start)
  const length = utf8(file, start, records.ends[record]!).length
  return { offset, length }
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
          throw Object.assign(problem('invalid-input', 'Duplicate JSON property: ' + name), {
            offset,
            length,
          })
        keys.add(name)
      },
      onError: (error, offset, length) => {
        // `PropertyNameExpected` reads as `Invalid JSON: property name expected`.
        const description = printParseErrorCode(error).replace(/(?<=[a-z])(?=[A-Z])/g, ' ')
        throw Object.assign(
          problem('invalid-input', 'Invalid JSON: ' + description.toLowerCase()),
          {
            offset,
            length,
          },
        )
      },
    },
    { disallowComments: true, allowTrailingComma: false },
  )
}

/** Each member the catalog does not know as a column of its table, typed by its values: numbers,
 *  booleans or strings as they are, anything else as its JSON text. Tables that have one take a
 *  shape with it; returns where each that GridKit reads is first. */
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
      const type: DecodeKind = !scalar
        ? 'json'
        : kinds.has('number')
          ? 'number'
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
        kind: type,
        starts: table.starts,
        get chunks() {
          return decode()
        },
      })
      plans.push({
        name,
        decode: type,
        source: { kind: 'found', path: members[0]!.path, json: !scalar },
        definition: { name, kind: type, label: name },
      })
      // GridKit's format leaves an extension's keys to each tool, so one Studio does not know is
      // another tool's, not a mistake.
      if (members[0]!.path[0] !== 'extension')
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
function caseTable(file: Uint8Array, layout: Layout, shape: Shape): Table {
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
      const type = field.decode
      if (
        type === 'text'
          ? typeof value === 'string'
          : typeof value === 'number' &&
            Number.isFinite(value) &&
            (type !== 'integer' || isInt32(value))
      )
        values.set(field.name, value as Value)
    }
  }
  const starts = Uint32Array.of(0, 1)
  /** A column of the one row's `value`, wrong when the file writes one that does not read. */
  const column = (type: DecodeKind, value: Value, given = value !== null): Column => ({
    kind: type,
    chunks: [chunkOf(type, [value])],
    starts,
    wrong: () => (given && value === null ? [0] : []),
  })
  return {
    shape,
    starts,
    ids: column('text', CASE_ROW),
    fields: new Map(
      shape.fields.map((field) => [
        field.name,
        column(field.decode, values.get(field.name) ?? null, supplied.has(field.name)),
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

/** Native references are validated against source identities without serializing physical rows. */
const resolved = new WeakMap<
  IndexedChunk,
  { ids: Column; values: Float64Array; wrong: readonly number[] }
>()
function references(native: readonly IndexedChunk[], starts: Uint32Array, target: Table): Column {
  const decode = deferred(() => {
    const wrong: number[] = []
    const chunks = native.map((source, c) => {
      let found = resolved.get(source)
      if (found?.ids !== target.ids) {
        const port = source.read() as Float64Array
        const ids = numberIds(target)
        const values = port.slice()
        const invalid = new Set(source.wrong())
        for (let at = 0; at < values.length; at++) {
          if (Number.isFinite(values[at]) && ids.row(values[at]!) < 0) {
            values[at] = NaN
            invalid.add(at)
          }
        }
        found = { ids: target.ids, values, wrong: [...invalid].sort((a, b) => a - b) }
        resolved.set(source, found)
      }
      for (const at of found.wrong) wrong.push(starts[c]! + at)
      return found.values
    })
    return { chunks, wrong }
  })
  return {
    kind: 'reference',
    target: target.shape.type,
    starts,
    get chunks() {
      return decode().chunks
    },
    wrong: () => decode().wrong,
  }
}

const nativeIds = new WeakMap<Column, readonly Id[]>()
function identities(table: Table): readonly Id[] {
  let ids = nativeIds.get(table.ids)
  if (!ids) {
    ids = table.ids.chunks.flatMap((chunk) =>
      Array.from({ length: chunk.length }, (_, at) => chunk[at] as Id),
    )
    nativeIds.set(table.ids, ids)
  }
  return ids
}

/** What a failure to index `table` says of its row `row`, which repeats an id: the record it is,
 *  as a parse problem names one. */
const repeated = (table: Table, row: number) =>
  table.shape.array === null
    ? {}
    : ({ target: { kind: 'path', path: [table.shape.array, table.records[row]!] } } as const)

const TEXT = new WeakMap<Column, TextIds>()
const NUMBER = new WeakMap<Column, NumberIds>()

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
  readonly #rows = new Map<string, number>()
  constructor(table: Table) {
    table.ids.chunks.forEach((chunk, index) => {
      for (let at = 0; at < chunk.length; at++) {
        const value = chunk[at]
        if (typeof value !== 'string') continue
        const row = table.starts[index]! + at
        if (this.#rows.has(value))
          throw problem(
            'invalid-input',
            'Two rows share the id ' + value + '.',
            repeated(table, row),
          )
        this.#rows.set(value, row)
      }
    })
  }
  row(id: string): number {
    return this.#rows.get(id) ?? -1
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
      const chunk = value as Float64Array
      for (let at = 0; at < chunk.length; at++) {
        if (!isValid(chunk, at)) continue
        const key = chunk[at]!
        keys[size] = key
        rows[size++] = column.starts[index]! + at
        if (key < min) min = key
        if (key > max) max = key
      }
    })
    this.#min = min
    const duplicate = (key: number, row: number): never => {
      throw problem('invalid-input', `Two rows share the number ${key}.`, repeated(table, row))
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
