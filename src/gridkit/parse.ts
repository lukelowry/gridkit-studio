/** A case's JSON bytes: members and records located in one pass over strings and brackets, then records
 *  parsed directly into columns. Unknown fields are skipped; invalid values become null. */

import type { DataType, Problem } from '@latkit/model'
import { failure } from '@latkit/model'

import {
  type Builder,
  builder,
  type Chunk,
  CHUNK_ROWS,
  type ListBuilder,
  NumericBuilder,
  type TextBuilder,
  type VectorBuilder,
} from './columns.js'
import type { ArrayName, Catalog, Shape } from './definition.js'
const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c
const COLON = 0x3a
const OPEN_OBJECT = 0x7b
const CLOSE_OBJECT = 0x7d
const OPEN_ARRAY = 0x5b
const CLOSE_ARRAY = 0x5d
const UTF8 = new TextEncoder()

export const ARRAYS: readonly ArrayName[] = ['buses', 'signals', 'devices']

export interface Member {
  readonly name: string
  /** The key's opening quote. */
  readonly start: number
  readonly value: number
  /** Just past the value. */
  readonly end: number
}

/** One array's brackets, and each record's start and end, in shared memory for the parse workers. */
export interface Records {
  readonly open: number
  readonly close: number
  readonly starts: Uint32Array
  readonly ends: Uint32Array
}

export interface Layout {
  readonly members: readonly Member[]
  /** The top-level object's closing brace. */
  readonly close: number
  readonly arrays: Readonly<Partial<Record<ArrayName, Records>>>
}

export function scan(bytes: Uint8Array): Layout {
  if (bytes.length >= 0xffffffff)
    throw failure('resource-limit', 'A case file must be smaller than 4 GiB.')
  let i = skipSpace(bytes, bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0)
  expect(bytes, i, OPEN_OBJECT, 'a case object')
  const members: Member[] = []
  const arrays: Partial<Record<ArrayName, Records>> = {}
  i = skipSpace(bytes, i + 1)
  while (bytes[i] !== CLOSE_OBJECT) {
    expect(bytes, i, QUOTE, 'a member name')
    const start = i
    const keyEnd = stringEnd(bytes, i)
    const name = keyOf(bytes, start, keyEnd)
    i = skipSpace(bytes, keyEnd)
    expect(bytes, i, COLON, 'a colon')
    const value = skipSpace(bytes, i + 1)
    let end: number
    if ((ARRAYS as readonly string[]).includes(name) && bytes[value] === OPEN_ARRAY) {
      const records = recordsOf(bytes, value)
      arrays[name as ArrayName] = records
      end = records.close + 1
    } else end = skipValue(bytes, value)
    members.push({ name, start, value, end })
    i = skipSpace(bytes, end)
    if (bytes[i] === COMMA) i = skipSpace(bytes, i + 1)
    else if (bytes[i] !== CLOSE_OBJECT) malformed(i, 'a comma or the end of the case')
  }
  if (skipSpace(bytes, i + 1) !== bytes.length) malformed(i + 1, 'the end of the file')
  return { members, close: i, arrays }
}

function recordsOf(bytes: Uint8Array, open: number): Records {
  let starts: Uint32Array = new Uint32Array(1024)
  let ends: Uint32Array = new Uint32Array(1024)
  let count = 0
  let i = skipSpace(bytes, open + 1)
  while (bytes[i] !== CLOSE_ARRAY) {
    expect(bytes, i, OPEN_OBJECT, 'a record')
    const end = skipValue(bytes, i)
    if (count === starts.length) {
      starts = grown(starts)
      ends = grown(ends)
    }
    starts[count] = i
    ends[count++] = end
    i = skipSpace(bytes, end)
    if (bytes[i] === COMMA) i = skipSpace(bytes, i + 1)
    else if (bytes[i] !== CLOSE_ARRAY) malformed(i, 'a comma or the end of the array')
  }
  return { open, close: i, starts: shared(starts, count), ends: shared(ends, count) }
}

/** Just past the JSON value at `i`. */
function skipValue(bytes: Uint8Array, i: number): number {
  const first = bytes[i]
  if (first === QUOTE) return stringEnd(bytes, i)
  if (first === OPEN_OBJECT || first === OPEN_ARRAY) {
    let depth = 0
    for (let at = i; at < bytes.length; at++) {
      const c = bytes[at]!
      if (c === QUOTE) at = stringEnd(bytes, at) - 1
      else if (c === OPEN_OBJECT || c === OPEN_ARRAY) depth++
      else if ((c === CLOSE_OBJECT || c === CLOSE_ARRAY) && --depth === 0) return at + 1
    }
    return malformed(i, 'a closed value')
  }
  let at = i
  while (at < bytes.length) {
    const c = bytes[at]!
    if (c === COMMA || c === CLOSE_OBJECT || c === CLOSE_ARRAY || c <= 0x20) break
    at++
  }
  return at === i ? malformed(i, 'a value') : at
}

/** Just past the string whose opening quote is at `i`. */
function stringEnd(bytes: Uint8Array, i: number): number {
  for (let at = i + 1; at < bytes.length; at++) {
    const c = bytes[at]
    if (c === BACKSLASH) at++
    else if (c === QUOTE) return at + 1
  }
  return malformed(i, 'a closed string')
}

export function skipSpace(bytes: Uint8Array, i: number): number {
  while (i < bytes.length) {
    const c = bytes[i]
    if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break
    i++
  }
  return i
}

/** The members of one object: per member, its key's text (inside the quotes) and its value, as four numbers. */
export class Members {
  spans = new Int32Array(256)

  /** Read the object at `open`; returns how many members it has. */
  read(bytes: Uint8Array, open: number): number {
    expect(bytes, open, OPEN_OBJECT, 'an object')
    let count = 0
    let i = skipSpace(bytes, open + 1)
    while (bytes[i] !== CLOSE_OBJECT) {
      expect(bytes, i, QUOTE, 'a member name')
      const keyEnd = stringEnd(bytes, i)
      const colon = skipSpace(bytes, keyEnd)
      expect(bytes, colon, COLON, 'a colon')
      const value = skipSpace(bytes, colon + 1)
      const end = skipValue(bytes, value)
      if ((count + 1) * 4 > this.spans.length) {
        const next = new Int32Array(this.spans.length * 2)
        next.set(this.spans)
        this.spans = next
      }
      this.spans.set([i + 1, keyEnd - 1, value, end], count++ * 4)
      i = skipSpace(bytes, end)
      if (bytes[i] === COMMA) i = skipSpace(bytes, i + 1)
      else if (bytes[i] !== CLOSE_OBJECT) malformed(i, 'a comma or the end of the object')
    }
    return count
  }
}

/** A key's text; escapes, which GridKit's keys never use, decoded the slow way. */
function keyOf(bytes: Uint8Array, start: number, end: number): string {
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start).toString('utf8')
  return raw.includes('\\') ? (JSON.parse(raw) as string) : raw.slice(1, -1)
}

function expect(bytes: Uint8Array, i: number, code: number, what: string): void {
  if (bytes[i] !== code) malformed(i, what)
}

function malformed(at: number, what: string): never {
  throw failure('invalid-input', `The case is not valid JSON: expected ${what} at byte ${at}.`)
}

function grown(array: Uint32Array): Uint32Array {
  const next = new Uint32Array(array.length * 2)
  next.set(array)
  return next
}

function shared(array: Uint32Array, count: number): Uint32Array {
  const out = new Uint32Array(new SharedArrayBuffer(count * 4))
  out.set(array.subarray(0, count))
  return out
}

/** Records of one array, the first of them record `first`. */
export interface Range {
  readonly array: ArrayName
  readonly first: number
  readonly starts: Uint32Array
}

export interface ParsedTable {
  readonly ids: readonly Chunk[]
  readonly fields: readonly (readonly Chunk[])[]
  readonly ports: readonly (readonly Chunk[])[]
}

export interface Parsed {
  /** By table code; null where the range has no record of the table. */
  readonly tables: readonly (ParsedTable | null)[]
  /** Each record's table code; NONE where it has none. */
  readonly codes: Uint16Array<ArrayBuffer>
  /** Each record's `mon` value, as its start and end in the file; 0, 0 where it has none. */
  readonly mons: Uint32Array<ArrayBuffer>
  readonly problems: readonly Problem[]
}

export const NONE = 0xffff

const POW10 = Array.from({ length: 23 }, (_, i) => 10 ** i)
const PROBLEMS = 50

/** A fixed set of keys, matched against key bytes with no string made. */
class Keys {
  readonly #slots: Int32Array
  readonly #names: readonly Uint8Array[]

  constructor(names: readonly string[]) {
    this.#names = names.map((name) => UTF8.encode(name))
    let size = 8
    while (size < names.length * 2) size *= 2
    this.#slots = new Int32Array(size)
    this.#names.forEach((name, i) => {
      let slot = hash(name, 0, name.length) & (size - 1)
      while (this.#slots[slot] !== 0) slot = (slot + 1) & (size - 1)
      this.#slots[slot] = i + 1
    })
  }

  /** The key's index, or -1. */
  find(bytes: Uint8Array, start: number, end: number): number {
    const mask = this.#slots.length - 1
    for (
      let slot = hash(bytes, start, end) & mask;
      this.#slots[slot] !== 0;
      slot = (slot + 1) & mask
    ) {
      const name = this.#names[this.#slots[slot]! - 1]!
      if (name.length !== end - start) continue
      let same = true
      for (let i = 0; i < name.length && same; i++) same = name[i] === bytes[start + i]
      if (same) return this.#slots[slot]! - 1
    }
    return -1
  }
}

function hash(bytes: Uint8Array, start: number, end: number): number {
  let h = 0x811c9dc5
  for (let i = start; i < end; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return h >>> 0
}

type Key = 'identity' | 'class' | 'name' | 'mon' | 'params' | 'init' | 'ports' | 'extension'
const RECORD: Record<ArrayName, readonly Key[]> = {
  buses: ['identity', 'class', 'name', 'init', 'params', 'mon', 'extension'],
  signals: ['identity', 'name'],
  devices: ['class', 'identity', 'ports', 'params', 'init', 'mon', 'extension'],
}
const RECORD_KEYS: Record<ArrayName, Keys> = {
  buses: new Keys(['number', 'class', 'name', 'init', 'params', 'mon', 'extension']),
  signals: new Keys(['signal_id', 'name']),
  devices: new Keys(['class', 'id', 'ports', 'params', 'init', 'mon', 'extension']),
}
const PLACE = new Keys(['longitude', 'latitude', 'polyline'])

/** One table's builders over a range, cut into chunks of at most CHUNK_ROWS rows. */
class Rows {
  readonly types: readonly DataType[]
  readonly params: Keys
  readonly init: Keys
  readonly portKeys: Keys
  /** The field each param and each init key fills. */
  readonly paramField: Int32Array
  readonly initField: Int32Array
  readonly named: number
  readonly position: number
  readonly route: number
  ids!: Builder
  fields!: Builder[]
  ports!: NumericBuilder[]
  #count = 0
  readonly #chunks: { ids: Chunk[]; fields: Chunk[][]; ports: Chunk[][] }

  constructor(readonly shape: Shape) {
    this.types = shape.fields.map((field) => field.definition.type)
    const params: string[] = []
    const initial: string[] = []
    const paramField: number[] = []
    const initField: number[] = []
    shape.fields.forEach(({ source }, index) => {
      if (source.kind === 'parameter') {
        params.push(source.name)
        paramField.push(index)
      }
      if (source.kind === 'initial') {
        initial.push(source.name)
        initField.push(index)
      }
    })
    this.params = new Keys(params)
    this.init = new Keys(initial)
    this.portKeys = new Keys(shape.ports.map((port) => port.source.name))
    this.paramField = Int32Array.from(paramField)
    this.initField = Int32Array.from(initField)
    this.named = shape.fields.findIndex(
      ({ source }) => source.kind === 'record' && source.name === 'name',
    )
    this.position = shape.fields.findIndex(({ source }) => source.kind === 'position')
    this.route = shape.fields.findIndex(({ source }) => source.kind === 'route')
    this.#chunks = { ids: [], fields: shape.fields.map(() => []), ports: shape.ports.map(() => []) }
    this.#fresh()
  }

  /** Make room for one more row, cutting a full chunk first. */
  next(): void {
    if (this.#count === CHUNK_ROWS) this.#flush()
    this.#count++
  }

  finish(): ParsedTable {
    this.#flush()
    return this.#chunks
  }

  #flush(): void {
    if (this.#count === 0) return
    this.#chunks.ids.push(this.ids.finish())
    this.fields.forEach((field, i) => this.#chunks.fields[i]!.push(field.finish()))
    this.ports.forEach((port, i) => this.#chunks.ports[i]!.push(port.finish()))
    this.#count = 0
    this.#fresh()
  }

  #fresh(): void {
    this.ids = builder(this.shape.identity.type)
    this.fields = this.types.map((type) => builder(type))
    this.ports = this.shape.ports.map(() => new NumericBuilder('uint32'))
  }
}

export class Parser {
  readonly #catalog: Catalog
  readonly #classes: Keys
  readonly #bus: Keys
  readonly #members = new Members()
  readonly #nested = new Members()
  /** The record being read: each field's and port's value as a start and end, -1 where absent. */
  #fields = new Int32Array(2 * 64)
  #ports = new Int32Array(2 * 64)
  readonly #place = new Int32Array(4)
  #id = -1
  #idEnd = -1
  #mon = 0
  #monEnd = 0
  #bytes: Uint8Array = new Uint8Array(0)
  #array: ArrayName = 'buses'
  #first = 0
  #tables: (Rows | null)[] = []
  #problems: Problem[] = []

  constructor(catalog: Catalog) {
    this.#catalog = catalog
    this.#classes = new Keys(catalog.codes.map((shape) => shape.type))
    this.#bus = new Keys([catalog.bus, 'BusInfinite'])
  }

  parse(bytes: Uint8Array, array: ArrayName, first: number, starts: Uint32Array): Parsed {
    this.#bytes = bytes
    this.#array = array
    this.#first = first
    this.#tables = this.#catalog.codes.map(() => null)
    this.#problems = []
    const codes = new Uint16Array(starts.length)
    const mons = new Uint32Array(2 * starts.length)
    for (let record = 0; record < starts.length; record++) {
      codes[record] = this.#record(starts[record]!, record)
      mons[2 * record] = this.#mon
      mons[2 * record + 1] = this.#monEnd
    }
    return {
      tables: this.#tables.map((rows) => rows?.finish() ?? null),
      codes,
      mons,
      problems: this.#problems,
    }
  }

  #record(start: number, record: number): number {
    const bytes = this.#bytes
    const count = this.#members.read(bytes, start)
    const spans = this.#members.spans
    this.#mon = this.#monEnd = 0
    const code =
      this.#array === 'buses' ? 0 : this.#array === 'signals' ? 1 : this.#classOf(count, record)
    if (code === NONE) return NONE
    const rows = (this.#tables[code] ??= new Rows(this.#catalog.codes[code]!))
    this.#stage(rows)
    const keys = RECORD_KEYS[this.#array]
    const names = RECORD[this.#array]
    for (let m = 0; m < count; m++) {
      const value = spans[4 * m + 2]!
      const end = spans[4 * m + 3]!
      const key = names[keys.find(bytes, spans[4 * m]!, spans[4 * m + 1]!)]
      if (key === 'identity') {
        this.#id = value
        this.#idEnd = end
      } else if (key === 'class') {
        if (
          this.#array === 'buses' &&
          !(bytes[value] === QUOTE && this.#bus.find(bytes, value + 1, end - 1) >= 0)
        )
          this.#problem(record, `A bus's class is not ${this.#catalog.bus}.`)
      } else if (key === 'name') stage(this.#fields, rows.named, value, end)
      else if (key === 'mon') {
        this.#mon = value
        this.#monEnd = end
      } else if (key !== undefined && bytes[value] === OPEN_OBJECT) this.#object(rows, key, value)
    }
    this.#commit(rows, record)
    return code
  }

  /** A device record's table code, from its class. */
  #classOf(count: number, record: number): number {
    const bytes = this.#bytes
    const spans = this.#members.spans
    for (let m = 0; m < count; m++) {
      if (RECORD_KEYS.devices.find(bytes, spans[4 * m]!, spans[4 * m + 1]!) !== 0) continue
      const value = spans[4 * m + 2]!
      const end = spans[4 * m + 3]!
      const code = bytes[value] === QUOTE ? this.#classes.find(bytes, value + 1, end - 1) : -1
      if (code >= 2) return code
      this.#problem(
        record,
        `The device class ${Buffer.from(bytes.subarray(value, end)).toString()} is not in the catalog.`,
      )
      return NONE
    }
    this.#problem(record, 'A device has no class.')
    return NONE
  }

  /** An object-valued member's members, each staged to its column. */
  #object(rows: Rows, key: Key, open: number): void {
    const bytes = this.#bytes
    const count = this.#nested.read(bytes, open)
    const spans = this.#nested.spans
    for (let m = 0; m < count; m++) {
      const keyStart = spans[4 * m]!
      const keyEnd = spans[4 * m + 1]!
      const value = spans[4 * m + 2]!
      const end = spans[4 * m + 3]!
      if (key === 'params')
        stage(
          this.#fields,
          rows.paramField[rows.params.find(bytes, keyStart, keyEnd)] ?? -1,
          value,
          end,
        )
      else if (key === 'init')
        stage(
          this.#fields,
          rows.initField[rows.init.find(bytes, keyStart, keyEnd)] ?? -1,
          value,
          end,
        )
      else if (key === 'ports')
        stage(this.#ports, rows.portKeys.find(bytes, keyStart, keyEnd), value, end)
      else if (key === 'extension') {
        const place = PLACE.find(bytes, keyStart, keyEnd)
        if (place === 2) stage(this.#fields, rows.route, value, end)
        else if (rows.position >= 0) stage(this.#place, place, value, end)
      }
    }
  }

  #stage(rows: Rows): void {
    const fields = 2 * rows.shape.fields.length
    const ports = 2 * rows.shape.ports.length
    if (this.#fields.length < fields) this.#fields = new Int32Array(fields)
    if (this.#ports.length < ports) this.#ports = new Int32Array(ports)
    this.#fields.fill(-1, 0, fields)
    this.#ports.fill(-1, 0, ports)
    this.#place.fill(-1)
    this.#id = -1
  }

  #commit(rows: Rows, record: number): void {
    rows.next()
    this.#identity(rows, record)
    for (let i = 0; i < rows.fields.length; i++) {
      const target = rows.fields[i]!
      if (i === rows.position) {
        this.#position(target as VectorBuilder)
        continue
      }
      const value = this.#fields[2 * i]!
      if (value < 0 || !this.#into(target, rows.types[i]!, value, this.#fields[2 * i + 1]!))
        target.push(null)
    }
    for (let i = 0; i < rows.ports.length; i++) {
      const value = this.#ports[2 * i]!
      const number = value < 0 ? NaN : parseNumber(this.#bytes, value, this.#ports[2 * i + 1]!)
      if (Number.isInteger(number) && number >= 0 && number <= 0xffffffff)
        rows.ports[i]!.pushNumber(number)
      else rows.ports[i]!.pushNull()
    }
  }

  #identity(rows: Rows, record: number): void {
    const { type, name } = rows.shape.identity
    if (this.#id < 0) {
      this.#problem(record, `A ${rows.shape.type} record has no ${name}.`)
      return rows.ids.push(null)
    }
    if (type === 'text') {
      if (this.#text(rows.ids as TextBuilder, this.#id, this.#idEnd)) return
      this.#problem(record, `A ${rows.shape.type} record's id is not text.`)
      return rows.ids.push(null)
    }
    const number = parseNumber(this.#bytes, this.#id, this.#idEnd)
    if (Number.isInteger(number) && number >= 0 && number <= 0xffffffff)
      return (rows.ids as NumericBuilder).pushNumber(number)
    this.#problem(record, `A ${rows.shape.type} record's ${name} is not a whole number.`)
    rows.ids.push(null)
  }

  /** A bus's longitude and latitude as its position. */
  #position(target: VectorBuilder): void {
    const place = this.#place
    const longitude = place[0]! < 0 ? NaN : parseNumber(this.#bytes, place[0]!, place[1]!)
    const latitude = place[2]! < 0 ? NaN : parseNumber(this.#bytes, place[2]!, place[3]!)
    if (Number.isFinite(longitude) && Number.isFinite(latitude)) target.push([longitude, latitude])
    else target.pushNull()
  }

  /** The value at [value, end) into `target`, if it has the field's type. */
  #into(target: Builder, type: DataType, value: number, end: number): boolean {
    const bytes = this.#bytes
    if (type === 'float64' || type === 'int32') {
      const number = parseNumber(bytes, value, end)
      if (!Number.isFinite(number)) return false
      if (type === 'int32' && (!Number.isInteger(number) || Math.abs(number) > 0x7fffffff))
        return false
      ;(target as NumericBuilder).pushNumber(number)
      return true
    }
    if (type === 'boolean') {
      const text = end - value <= 5 ? String.fromCharCode(...bytes.subarray(value, end)) : ''
      if (text !== 'true' && text !== 'false') return false
      target.push(text === 'true')
      return true
    }
    if (type === 'text') return this.#text(target as TextBuilder, value, end)
    if (typeof type !== 'object' || type.kind !== 'list') return false
    // A route: points of two finite numbers, each list checked whole before any of it is kept.
    const list = target as ListBuilder
    const lanes: number[] = []
    const point = (at: number): number => {
      lanes.length = 0
      const close = eachItem(bytes, at, (lane) => {
        let stop = lane
        while (
          stop < end &&
          bytes[stop] !== COMMA &&
          bytes[stop] !== CLOSE_ARRAY &&
          bytes[stop]! > 0x20
        )
          stop++
        lanes.push(parseNumber(bytes, lane, stop))
        return stop
      })
      return close < 0 || lanes.length !== 2 || !lanes.every(Number.isFinite) ? -1 : close
    }
    if (eachItem(bytes, value, point) < 0) return false
    eachItem(bytes, value, (at) => {
      const close = point(at)
      ;(list.items as VectorBuilder).push(lanes)
      return close
    })
    list.commit()
    return true
  }

  /** A JSON string's text into `target`: its bytes as they are, unless it has escapes to decode. */
  #text(target: TextBuilder, value: number, end: number): boolean {
    const bytes = this.#bytes
    if (bytes[value] !== QUOTE) return false
    for (let i = value + 1; i < end - 1; i++)
      if (bytes[i] === BACKSLASH) {
        target.push(JSON.parse(Buffer.from(bytes.subarray(value, end)).toString('utf8')) as string)
        return true
      }
    target.pushUtf8(bytes, value + 1, end - 1)
    return true
  }

  #problem(record: number, message: string): void {
    if (this.#problems.length < PROBLEMS)
      this.#problems.push({
        code: 'invalid-input',
        message,
        target: { kind: 'path', path: [this.#array, this.#first + record] },
      })
  }
}

function stage(spans: Int32Array, at: number, value: number, end: number): void {
  if (at < 0) return
  spans[2 * at] = value
  spans[2 * at + 1] = end
}

/** Visit each item of the array at `open`; `item` returns just past the item, or -1 to refuse it. Returns just
 *  past the array, or -1 when it is not an array or an item was refused. */
function eachItem(bytes: Uint8Array, open: number, item: (at: number) => number): number {
  if (bytes[open] !== OPEN_ARRAY) return -1
  let at = skipSpace(bytes, open + 1)
  while (bytes[at] !== CLOSE_ARRAY) {
    const next = item(at)
    if (next < 0) return -1
    at = skipSpace(bytes, next)
    if (bytes[at] === COMMA) at = skipSpace(bytes, at + 1)
    else if (bytes[at] !== CLOSE_ARRAY) return -1
  }
  return at + 1
}

/** A JSON number from its digits: exact through Clinger's fast path when it has at most 15 significant digits and
 *  a small exponent, else through the platform's parser. NaN when it is not a JSON number. */
function parseNumber(bytes: Uint8Array, start: number, end: number): number {
  let i = start
  const negative = bytes[i] === 0x2d
  if (negative) i++
  let mantissa = 0
  let digits = 0
  let exponent = 0
  const digit = (at: number): boolean => at < end && bytes[at]! >= 0x30 && bytes[at]! <= 0x39
  if (bytes[i] === 0x30) i++
  else if (!digit(i)) return NaN
  else
    for (; digit(i); i++) {
      if (digits < 16) mantissa = mantissa * 10 + bytes[i]! - 0x30
      else exponent++
      if (mantissa > 0) digits++
    }
  if (bytes[i] === 0x2e) {
    const fraction = ++i
    for (; digit(i); i++)
      if (digits < 16) {
        mantissa = mantissa * 10 + bytes[i]! - 0x30
        exponent--
        if (mantissa > 0) digits++
      }
    if (i === fraction) return NaN
  }
  if (i < end && (bytes[i] === 0x65 || bytes[i] === 0x45)) {
    i++
    const sign = bytes[i] === 0x2d ? -1 : 1
    if (bytes[i] === 0x2d || bytes[i] === 0x2b) i++
    if (!digit(i)) return NaN
    let power = 0
    for (; digit(i); i++) power = power * 10 + bytes[i]! - 0x30
    exponent += sign * power
  }
  if (i !== end) return NaN
  if (digits <= 15 && exponent >= -22 && exponent <= 22) {
    const value = exponent >= 0 ? mantissa * POW10[exponent]! : mantissa / POW10[-exponent]!
    return negative ? -value : value
  }
  return Number(String.fromCharCode(...bytes.subarray(start, end)))
}
