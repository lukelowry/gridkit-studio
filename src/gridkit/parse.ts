/** A case's JSON bytes: members and records indexed once, then columns decoded on demand.
 *  A member the catalog does not know, or a device class, is
 *  found and kept for its own column or table; invalid values become null. */

import type { Failure, Schema } from '@latkit/model'
import { failure } from '@latkit/model'

import {
  type Builder,
  builder,
  type Chunk,
  CHUNK_ROWS,
  deferred,
  hash,
  isInt32,
  type ListBuilder,
  NumericBuilder,
  STEP_RECORDS,
  type TextBuilder,
  utf8,
  type VectorBuilder,
} from './columns.js'
import {
  type ArrayName,
  BUS_CODE,
  CASE,
  type Catalog,
  DEVICE_CODES,
  type Shape,
  SIGNAL_CODE,
  unknownShape,
} from './definition.js'
import { Turns } from './turns.js'

const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c
const COLON = 0x3a
const OPEN_OBJECT = 0x7b
const CLOSE_OBJECT = 0x7d
const OPEN_ARRAY = 0x5b
const CLOSE_ARRAY = 0x5d
const UTF8 = new TextEncoder()
/** Reads a number token, checked as JSON by then, however many digits it has. */
const ASCII = new TextDecoder()

export const ARRAYS: readonly ArrayName[] = ['buses', 'signals', 'devices']

export interface Member {
  readonly name: string
  /** The key's opening quote. */
  readonly start: number
  readonly value: number
  /** Just past the value. */
  readonly end: number
}

/** One array's brackets, and each record's start and end. */
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

/** The case's members, and each array's records, found as the whole file is checked to be JSON
 *  with no object that repeats a key: what is read after takes the JSON as it is. Read a slice at a
 *  time, until `signal` lets go. */
export async function scan(bytes: Uint8Array, signal = AbortSignal.any([])): Promise<Layout> {
  const work = new Turns(signal)
  if (bytes.length >= 0xffffffff)
    throw failure('resource-limit', 'A case file must be smaller than 4 GiB.')
  let i = skipSpace(bytes, bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0)
  expect(bytes, i, OPEN_OBJECT, 'a case object')
  const members: Member[] = []
  const names = new Set<string>()
  const arrays: Partial<Record<ArrayName, Records>> = {}
  i = skipSpace(bytes, i + 1)
  while (bytes[i] !== CLOSE_OBJECT) {
    expect(bytes, i, QUOTE, 'a member name')
    const start = i
    const keyEnd = checkString(bytes, i)
    const name = keyOf(bytes, start, keyEnd)
    if (names.has(name)) malformed(start, 'a member name the case has not used')
    names.add(name)
    i = skipSpace(bytes, keyEnd)
    expect(bytes, i, COLON, 'a colon')
    const value = skipSpace(bytes, i + 1)
    let end: number
    if ((ARRAYS as readonly string[]).includes(name) && bytes[value] === OPEN_ARRAY) {
      const records = await recordsOf(bytes, value, work)
      arrays[name as ArrayName] = records
      end = records.close + 1
    } else end = checkValue(bytes, value)
    members.push({ name, start, value, end })
    i = skipSpace(bytes, end)
    if (bytes[i] === COMMA) i = skipSpace(bytes, i + 1)
    else if (bytes[i] !== CLOSE_OBJECT) malformed(i, 'a comma or the end of the case')
  }
  if (skipSpace(bytes, i + 1) !== bytes.length) malformed(i + 1, 'the end of the file')
  return { members, close: i, arrays }
}

async function recordsOf(bytes: Uint8Array, open: number, work: Turns): Promise<Records> {
  return { open, ...(await recordsFrom(bytes, open + 1, work)) }
}

/** The records of an array of `bytes` from `from`, a record's start or just past the array's
 *  opening bracket, each checked as JSON whole, and where they end: just past the record that ends
 *  at `to`, when given, else at the array's closing bracket. */
async function recordsFrom(
  bytes: Uint8Array,
  from: number,
  work: Turns,
  to?: number,
): Promise<{ close: number; starts: Uint32Array; ends: Uint32Array }> {
  let starts: Uint32Array = new Uint32Array(1024)
  let ends: Uint32Array = new Uint32Array(1024)
  let count = 0
  const done = (close: number) => ({
    close,
    starts: starts.slice(0, count),
    ends: ends.slice(0, count),
  })
  let i = skipSpace(bytes, from)
  if (to === undefined && bytes[i] === CLOSE_ARRAY) return done(i)
  for (;;) {
    if ((count & STEP_RECORDS) === 0) await work.step()
    expect(bytes, i, OPEN_OBJECT, 'a record')
    const end = checkValue(bytes, i)
    if (count === starts.length) {
      starts = grown(starts)
      ends = grown(ends)
    }
    starts[count] = i
    ends[count++] = end
    if (end === to) return done(-1)
    if (to !== undefined && end > to) malformed(i, 'a record that ends where one ended')
    i = skipSpace(bytes, end)
    if (bytes[i] === COMMA) i = skipSpace(bytes, i + 1)
    else if (to === undefined && bytes[i] === CLOSE_ARRAY) return done(i)
    else malformed(i, 'a comma or the end of the array')
  }
}

/** The records of an array of `bytes` from `from` up to `to`, checked as `scan` checks them, each a
 *  start and an end: `from` is a record's start or just past the array's opening bracket, and `to`
 *  is just past a record, or, when `closing`, the array's closing bracket. */
export async function recordsBetween(
  bytes: Uint8Array,
  from: number,
  to: number,
  closing: boolean,
  signal = AbortSignal.any([]),
): Promise<{ starts: Uint32Array; ends: Uint32Array }> {
  const work = new Turns(signal)
  const read = await recordsFrom(bytes, from, work, closing ? undefined : to)
  if (closing && read.close !== to) malformed(read.close, 'the end of the array where it was')
  return read
}

/** Where each open object's keys are, and their hashes, as `checkValue` reads: a key is compared
 *  only with those of its own object that hash alike. Grown as needed, and kept between calls. */
let keyStarts: Int32Array = new Int32Array(256)
let keyEnds: Int32Array = new Int32Array(256)
let keyHashes: Int32Array = new Int32Array(256)

/** Just past the JSON value at `i`, checked as JSON whole: its grammar, without comments or trailing
 *  commas, and no object in it that repeats a key. A value nests as deep as it likes: the open
 *  objects and arrays are counted, never recursed into. */
function checkValue(bytes: Uint8Array, start: number): number {
  /** Per open container, 1 for an object, 0 for an array; where an object's keys begin; and, once
   *  it has many, its keys by hash. */
  const objects: number[] = []
  const firsts: number[] = []
  const indexes: (Map<number, number[]> | undefined)[] = []
  let keys = 0
  let i = start
  /** Reads the key at `i`, a repeat of none before it in its object; returns past its colon. */
  const key = (): number => {
    expect(bytes, i, QUOTE, 'a member name')
    const end = checkString(bytes, i)
    const hashed = hash(bytes, i, end) | 0
    const first = firsts.at(-1)!
    // A few keys are compared in turn; an object with many finds those that hash alike.
    let index = indexes.at(-1)
    if (!index && keys - first >= INDEXED_KEYS) {
      index = new Map()
      for (let k = first; k < keys; k++) indexed(index, keyHashes[k]!, k)
      indexes[indexes.length - 1] = index
    }
    if (index) {
      for (const k of index.get(hashed) ?? [])
        if (sameKey(bytes, keyStarts[k]!, keyEnds[k]!, i, end))
          malformed(i, 'a member name its object has not used')
      indexed(index, hashed, keys)
    } else
      for (let k = first; k < keys; k++)
        if (keyHashes[k] === hashed && sameKey(bytes, keyStarts[k]!, keyEnds[k]!, i, end))
          malformed(i, 'a member name its object has not used')
    if (keys === keyStarts.length) {
      keyStarts = grownInt(keyStarts)
      keyEnds = grownInt(keyEnds)
      keyHashes = grownInt(keyHashes)
    }
    keyStarts[keys] = i
    keyEnds[keys] = end
    keyHashes[keys++] = hashed
    const colon = skipSpace(bytes, end)
    expect(bytes, colon, COLON, 'a colon')
    return colon + 1
  }
  for (;;) {
    // A value at `i`.
    i = skipSpace(bytes, i)
    const first = bytes[i]
    if (first === OPEN_OBJECT || first === OPEN_ARRAY) {
      const object = first === OPEN_OBJECT
      i = skipSpace(bytes, i + 1)
      if (bytes[i] !== (object ? CLOSE_OBJECT : CLOSE_ARRAY)) {
        objects.push(object ? 1 : 0)
        firsts.push(keys)
        indexes.push(undefined)
        if (object) i = key()
        continue
      }
      i++
    } else if (first === QUOTE) i = checkString(bytes, i)
    else if (first === 0x74) i = checkWord(bytes, i, TRUE)
    else if (first === 0x66) i = checkWord(bytes, i, FALSE)
    else if (first === 0x6e) i = checkWord(bytes, i, NULL)
    else i = checkNumber(bytes, i)
    // Past a value: the next of its container's, or the container's end, and so on out.
    for (;;) {
      if (!objects.length) return i
      i = skipSpace(bytes, i)
      const object = objects.at(-1) === 1
      if (bytes[i] === COMMA) {
        i = skipSpace(bytes, i + 1)
        if (object) i = key()
        break
      }
      if (bytes[i] !== (object ? CLOSE_OBJECT : CLOSE_ARRAY))
        malformed(i, object ? 'a comma or the end of an object' : 'a comma or the end of an array')
      i++
      objects.pop()
      indexes.pop()
      keys = firsts.pop()!
    }
  }
}

/** How many keys an object has before its keys are found by hash rather than compared in turn. */
const INDEXED_KEYS = 128

/** Notes key `k`, which hashes as `hashed`, in `index`. */
function indexed(index: Map<number, number[]>, hashed: number, k: number): void {
  const alike = index.get(hashed)
  if (alike) alike.push(k)
  else index.set(hashed, [k])
}

const TRUE = UTF8.encode('true')
const FALSE = UTF8.encode('false')
const NULL = UTF8.encode('null')

/** Just past the literal `word` at `i`. */
function checkWord(bytes: Uint8Array, i: number, word: Uint8Array): number {
  for (let k = 0; k < word.length; k++) if (bytes[i + k] !== word[k]) malformed(i, 'a value')
  return i + word.length
}

/** Just past the JSON number at `i`: a sign, an integer part without leading zeros, and a fraction
 *  and an exponent, each with digits. */
function checkNumber(bytes: Uint8Array, i: number): number {
  const start = i
  const digits = () => {
    const from = i
    while (bytes[i]! >= 0x30 && bytes[i]! <= 0x39) i++
    if (i === from) malformed(start, 'a value')
  }
  if (bytes[i] === 0x2d) i++
  if (bytes[i] === 0x30) i++
  else digits()
  if (bytes[i] === 0x2e) {
    i++
    digits()
  }
  if (bytes[i] === 0x65 || bytes[i] === 0x45) {
    i++
    if (bytes[i] === 0x2b || bytes[i] === 0x2d) i++
    digits()
  }
  return i
}

/** Just past the JSON string whose opening quote is at `i`: no control character in it, and each
 *  escape one JSON has. */
function checkString(bytes: Uint8Array, i: number): number {
  for (let at = i + 1; at < bytes.length; at++) {
    const c = bytes[at]!
    if (c === QUOTE) return at + 1
    if (c < 0x20) malformed(at, 'a string without control characters')
    if (c !== BACKSLASH) continue
    const escaped = bytes[++at]
    if (escaped === 0x75) {
      for (let k = 1; k <= 4; k++) if (!isHex(bytes[at + k])) malformed(at, 'four hex digits')
      at += 4
    } else if (!ESCAPES.has(escaped!)) malformed(at, 'an escape JSON has')
  }
  return malformed(i, 'a closed string')
}

/** `"`, `\`, `/`, `b`, `f`, `n`, `r` and `t`, as an escape names them. */
const ESCAPES = new Set([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74])

const isHex = (c: number | undefined) =>
  c !== undefined && ((c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x66))

/** Whether the keys at `[a, aEnd)` and `[b, bEnd)` name the same: their bytes, or, with escapes,
 *  the text they decode to. */
function sameKey(bytes: Uint8Array, a: number, aEnd: number, b: number, bEnd: number): boolean {
  if (aEnd - a === bEnd - b) {
    let same = true
    for (let k = 0; k < aEnd - a && same; k++) same = bytes[a + k] === bytes[b + k]
    if (same) return true
  }
  const escaped = (from: number, to: number) => bytes.subarray(from, to).includes(BACKSLASH)
  return (escaped(a, aEnd) || escaped(b, bEnd)) && keyOf(bytes, a, aEnd) === keyOf(bytes, b, bEnd)
}

function grownInt(array: Int32Array): Int32Array {
  const next = new Int32Array(array.length * 2)
  next.set(array)
  return next
}

/** Just past the JSON value at `i`, which `scan` has checked. */
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

function skipSpace(bytes: Uint8Array, i: number): number {
  while (i < bytes.length) {
    const c = bytes[i]
    if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break
    i++
  }
  return i
}

/** One object's members, four numbers each: its key's text inside the quotes, and its value. */
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
  throw Object.assign(
    failure('invalid-input', `The case is not valid JSON: expected ${what} at byte ${at}.`),
    { byte: at },
  )
}

function grown(array: Uint32Array): Uint32Array {
  const next = new Uint32Array(array.length * 2)
  next.set(array)
  return next
}

/** Records of one array, the first of them record `first`. */
export interface Range {
  readonly array: ArrayName
  readonly first: number
  readonly starts: Uint32Array
}

export interface IndexedChunk {
  read(): Chunk
  supplied(row: number): boolean
}

interface ParsedTable {
  readonly ids: readonly Chunk[]
  readonly fields: readonly (readonly IndexedChunk[])[]
  readonly ports: readonly (readonly IndexedChunk[])[]
}

/** A member the catalog does not know: the record it is in, its path there, and its value. */
export interface Found {
  readonly code: number
  /** The record's index in its range. */
  readonly record: number
  readonly path: readonly string[]
  readonly value: number
  readonly end: number
}

export interface Parsed {
  /** Where the range's bytes are, which its columns not yet decoded read. */
  readonly source: Source
  /** By table code; null where the range has no record of the table. */
  readonly tables: readonly (ParsedTable | null)[]
  readonly found: readonly Found[]
  /** Each record's table code; NONE where it has none. */
  readonly codes: Uint16Array<ArrayBuffer>
  /** Each record's `mon` value, as its start and end in the file; 0, 0 where it has none. */
  readonly mons: Uint32Array<ArrayBuffer>
  readonly problems: readonly Failure.Problem[]
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
/** What Studio keeps under `extension` for itself, and never shows as a field. */
const OWN = new Keys(['diagram'])

/** Where the bytes of a range were parsed from are now: the file that holds them, and how far past
 *  where they were parsed they lie. A range a later revision keeps is pointed at that revision's
 *  file, so what it has yet to decode reads the same bytes there, and no older file stays alive
 *  for it. */
export interface Source {
  bytes: Uint8Array
  shift: number
}

/** A column of the rows whose values `spans` place in `source`, each a start and an end, -1 where
 *  a row has none: decoded on its first read, when it lets go of its spans and its source. A
 *  port's value is the number of the row it names. */
function lazyColumn(
  source: Source,
  spans: Int32Array,
  type: Schema.FieldType,
  port: boolean,
): IndexedChunk {
  // Held apart, so the decoded column keeps nothing of the file alive.
  let unread: { source: Source; spans: Int32Array } | undefined = { source, spans }
  const decode = deferred(() => {
    const { source, spans: own } = unread!
    unread = undefined
    const { bytes, shift } = source
    const rows = own.length / 2
    const target = builder(type)
    const supplied = new Uint8Array(Math.ceil(rows / 8))
    for (let row = 0; row < rows; row++) {
      const at = own[2 * row]!
      const value = at < 0 ? at : at + shift
      const end = own[2 * row + 1]! + shift
      if (value >= 0 && bytes[value] !== 0x6e) supplied[row >>> 3]! |= 1 << (row & 7)
      if (port) {
        const number = value < 0 ? NaN : parseNumber(bytes, value, end)
        if (Number.isInteger(number) && number >= 0 && number <= 0xffffffff)
          (target as NumericBuilder).pushNumber(number)
        else target.push(null)
      } else if (value < 0 || !into(bytes, target, type, value, end)) target.push(null)
    }
    return { chunk: target.finish(), supplied }
  })
  return {
    read: () => decode().chunk,
    supplied: (row) => (decode().supplied[row >>> 3]! & (1 << (row & 7))) !== 0,
  }
}

/** One table's identities and value spans, cut into chunks of at most CHUNK_ROWS rows. */
class Rows {
  readonly types: readonly Schema.FieldType[]
  readonly params: Keys
  readonly init: Keys
  readonly extension: Keys
  readonly portKeys: Keys
  /** The field each param, init and extension key fills. */
  readonly paramField: Int32Array
  readonly initField: Int32Array
  readonly extensionField: Int32Array
  readonly named: number
  ids!: Builder
  #spans!: Int32Array
  readonly #width: number
  #count = 0
  readonly #chunks: { ids: Chunk[]; fields: IndexedChunk[][]; ports: IndexedChunk[][] }

  constructor(
    readonly shape: Shape,
    readonly source: Source,
  ) {
    this.#width = 2 * (shape.fields.length + shape.ports.length)
    this.types = shape.fields.map((field) => field.definition.type)
    const keys = { parameter: [] as string[], initial: [] as string[], extension: [] as string[] }
    const fields = { parameter: [] as number[], initial: [] as number[], extension: [] as number[] }
    shape.fields.forEach(({ source }, index) => {
      if (source.kind === 'parameter' || source.kind === 'initial' || source.kind === 'extension') {
        keys[source.kind].push(source.name)
        fields[source.kind].push(index)
      }
    })
    this.params = new Keys(keys.parameter)
    this.init = new Keys(keys.initial)
    this.extension = new Keys(keys.extension)
    this.portKeys = new Keys(shape.ports.map((port) => port.source.name))
    this.paramField = Int32Array.from(fields.parameter)
    this.initField = Int32Array.from(fields.initial)
    this.extensionField = Int32Array.from(fields.extension)
    this.named = shape.fields.findIndex(
      ({ source }) => source.kind === 'record' && source.name === 'name',
    )
    this.#chunks = { ids: [], fields: shape.fields.map(() => []), ports: shape.ports.map(() => []) }
    this.#fresh()
  }

  /** Make room for one more row, cutting a full chunk first. */
  next(): void {
    if (this.#count === CHUNK_ROWS) this.#flush()
    this.#count++
    if (this.#count * this.#width > this.#spans.length) {
      const next = new Int32Array(this.#spans.length * 2)
      next.set(this.#spans)
      this.#spans = next
    }
  }

  /** Keep locations, not decoded values. Identity is the only eager column. */
  stage(fields: Int32Array, ports: Int32Array): void {
    const offset = (this.#count - 1) * this.#width
    this.#spans.set(fields.subarray(0, 2 * this.shape.fields.length), offset)
    this.#spans.set(
      ports.subarray(0, 2 * this.shape.ports.length),
      offset + 2 * this.shape.fields.length,
    )
  }

  finish(): ParsedTable {
    this.#flush()
    return this.#chunks
  }

  #flush(): void {
    if (this.#count === 0) return
    this.#chunks.ids.push(this.ids.finish())
    const fields = this.types.length
    this.types.forEach((type, i) =>
      this.#chunks.fields[i]!.push(lazyColumn(this.source, this.#slot(i), type, false)),
    )
    this.shape.ports.forEach((_, i) =>
      this.#chunks.ports[i]!.push(lazyColumn(this.source, this.#slot(fields + i), 'uint32', true)),
    )
    this.#count = 0
    this.#fresh()
  }

  /** Each row's value of slot `slot`, as its start and end, of the rows staged. */
  #slot(slot: number): Int32Array {
    const spans = new Int32Array(2 * this.#count)
    for (let row = 0, at = 2 * slot; row < this.#count; row++, at += this.#width) {
      spans[2 * row] = this.#spans[at]!
      spans[2 * row + 1] = this.#spans[at + 1]!
    }
    return spans
  }

  #fresh(): void {
    this.ids = builder(this.shape.identity.type)
    this.#spans = new Int32Array(256 * this.#width)
  }
}

/** How a parser codes the tables it reads: each shape by its code, the catalog's, then each class it
 *  does not know, as found, by its name. */
export interface Coding {
  readonly shapes: readonly Shape[]
  readonly unknown: ReadonlyMap<string, number>
}

export class Parser {
  readonly #classes: Keys
  readonly #bus: Keys
  /** Every table's shape by code: the catalog's, then each class it does not know, as found. */
  readonly #shapes: Shape[]
  readonly #unknown: Map<string, number>
  #source: Source = { bytes: new Uint8Array(0), shift: 0 }
  readonly #members = new Members()
  readonly #nested = new Members()
  /** The record being read: each field's and port's value as a start and end, -1 where absent. */
  #fields = new Int32Array(2 * 64)
  #ports = new Int32Array(2 * 64)
  #id = -1
  #idEnd = -1
  #mon = 0
  #monEnd = 0
  #bytes: Uint8Array = new Uint8Array(0)
  #array: ArrayName = 'buses'
  #first = 0
  #tables: (Rows | null)[] = []
  #found: Found[] = []
  #problems: Failure.Problem[] = []

  /** A parser of `catalog`'s cases, coding tables as `coding` did when given, so ranges it reads join
   *  those another parser read with it. */
  constructor(catalog: Catalog, coding?: Coding) {
    this.#classes = new Keys(catalog.codes.map((shape) => shape.type))
    this.#bus = new Keys([catalog.bus, 'BusInfinite'])
    this.#shapes = [...(coding?.shapes ?? catalog.codes)]
    this.#unknown = new Map(coding?.unknown)
  }

  /** How it codes tables, the classes found so far included. */
  get coding(): Coding {
    return { shapes: [...this.#shapes], unknown: new Map(this.#unknown) }
  }

  parse(bytes: Uint8Array, array: ArrayName, first: number, starts: Uint32Array): Parsed {
    this.#bytes = bytes
    this.#source = { bytes, shift: 0 }
    this.#array = array
    this.#first = first
    this.#tables = []
    this.#found = []
    this.#problems = []
    const codes = new Uint16Array(starts.length)
    const mons = new Uint32Array(2 * starts.length)
    for (let record = 0; record < starts.length; record++) {
      codes[record] = this.#record(starts[record]!, record)
      mons[2 * record] = this.#mon
      mons[2 * record + 1] = this.#monEnd
    }
    return {
      source: this.#source,
      tables: Array.from(this.#shapes, (_, code) => this.#tables[code]?.finish() ?? null),
      found: this.#found,
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
      this.#array === 'buses'
        ? BUS_CODE
        : this.#array === 'signals'
          ? SIGNAL_CODE
          : this.#classOf(count, record)
    if (code === NONE) return NONE
    const rows = (this.#tables[code] ??= new Rows(this.#shapes[code]!, this.#source))
    this.#stage(rows)
    const keys = RECORD_KEYS[this.#array]
    const names = RECORD[this.#array]
    for (let m = 0; m < count; m++) {
      const value = spans[4 * m + 2]!
      const end = spans[4 * m + 3]!
      const keyStart = spans[4 * m]!
      const keyEnd = spans[4 * m + 1]!
      const key = names[keys.find(bytes, keyStart, keyEnd)]
      if (key === 'identity') {
        this.#id = value
        this.#idEnd = end
      } else if (key === 'class') {
        // A bus class GridKit may add is kept, as its own column, rather than refused.
        if (
          this.#array === 'buses' &&
          !(bytes[value] === QUOTE && this.#bus.find(bytes, value + 1, end - 1) >= 0)
        )
          this.#find(code, record, ['class'], value, end)
      } else if (key === 'name') stage(this.#fields, rows.named, value, end)
      else if (key === 'mon') {
        this.#mon = value
        this.#monEnd = end
      } else if (key !== undefined && bytes[value] === OPEN_OBJECT)
        this.#object(rows, key, value, code, record)
      else this.#find(code, record, [utf8(bytes, keyStart, keyEnd)], value, end)
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
      if (bytes[value] !== QUOTE) break
      const code = this.#classes.find(bytes, value + 1, end - 1)
      if (code >= DEVICE_CODES) return code
      const name = utf8(bytes, value + 1, end - 1)
      // A bus, a signal and the case are types of their own, never a device's class.
      if (code >= 0 || name === CASE) {
        this.#problem(record, `${name} is not a device class.`)
        return NONE
      }
      // A class the catalog does not know is a table of its own, its members found as they are.
      let found = this.#unknown.get(name)
      if (found === undefined) {
        found = this.#shapes.push(unknownShape(name)) - 1
        this.#unknown.set(name, found)
      }
      return found
    }
    this.#problem(record, 'A device has no class.')
    return NONE
  }

  /** An object-valued member's members, each staged to its column, or found. */
  #object(rows: Rows, key: Key, open: number, code: number, record: number): void {
    const bytes = this.#bytes
    const count = this.#nested.read(bytes, open)
    const spans = this.#nested.spans
    for (let m = 0; m < count; m++) {
      const keyStart = spans[4 * m]!
      const keyEnd = spans[4 * m + 1]!
      const value = spans[4 * m + 2]!
      const end = spans[4 * m + 3]!
      let known = -1
      if (key === 'params') known = rows.paramField[rows.params.find(bytes, keyStart, keyEnd)] ?? -1
      else if (key === 'init') known = rows.initField[rows.init.find(bytes, keyStart, keyEnd)] ?? -1
      else if (key === 'extension') {
        if (OWN.find(bytes, keyStart, keyEnd) >= 0) continue
        known = rows.extensionField[rows.extension.find(bytes, keyStart, keyEnd)] ?? -1
      } else if (key === 'ports') {
        const port = rows.portKeys.find(bytes, keyStart, keyEnd)
        if (port >= 0) {
          stage(this.#ports, port, value, end)
          continue
        }
      }
      if (known >= 0) stage(this.#fields, known, value, end)
      else this.#find(code, record, [key, utf8(bytes, keyStart, keyEnd)], value, end)
    }
  }

  #find(code: number, record: number, path: readonly string[], value: number, end: number): void {
    this.#found.push({ code, record, path, value, end })
  }

  #stage(rows: Rows): void {
    const fields = 2 * rows.shape.fields.length
    const ports = 2 * rows.shape.ports.length
    if (this.#fields.length < fields) this.#fields = new Int32Array(fields)
    if (this.#ports.length < ports) this.#ports = new Int32Array(ports)
    this.#fields.fill(-1, 0, fields)
    this.#ports.fill(-1, 0, ports)
    this.#id = -1
  }

  #commit(rows: Rows, record: number): void {
    rows.next()
    this.#identity(rows, record)
    rows.stage(this.#fields, this.#ports)
  }

  #identity(rows: Rows, record: number): void {
    const { type, name } = rows.shape.identity
    if (this.#id < 0) {
      this.#problem(record, `A ${rows.shape.type} record has no ${name}.`)
      return rows.ids.push(null)
    }
    if (type === 'text') {
      if (textInto(this.#bytes, rows.ids as TextBuilder, this.#id, this.#idEnd)) return
      this.#problem(record, `A ${rows.shape.type} record's id is not text.`)
      return rows.ids.push(null)
    }
    const number = parseNumber(this.#bytes, this.#id, this.#idEnd)
    if (Number.isInteger(number) && number >= 0 && number <= 0xffffffff)
      return (rows.ids as NumericBuilder).pushNumber(number)
    this.#problem(record, `A ${rows.shape.type} record's ${name} is not a whole number.`)
    rows.ids.push(null)
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

/** The value at [value, end) into `target`, if it has the field's type. */
function into(
  bytes: Uint8Array,
  target: Builder,
  type: Schema.FieldType,
  value: number,
  end: number,
): boolean {
  if (type === 'float64' || type === 'int32') {
    const number = parseNumber(bytes, value, end)
    if (!Number.isFinite(number)) return false
    if (type === 'int32' && !isInt32(number)) return false
    ;(target as NumericBuilder).pushNumber(number)
    return true
  }
  if (type === 'boolean') {
    const text = end - value <= 5 ? String.fromCharCode(...bytes.subarray(value, end)) : ''
    if (text !== 'true' && text !== 'false') return false
    target.push(text === 'true')
    return true
  }
  if (type === 'text') return textInto(bytes, target as TextBuilder, value, end)
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
function textInto(bytes: Uint8Array, target: TextBuilder, value: number, end: number): boolean {
  if (bytes[value] !== QUOTE) return false
  for (let i = value + 1; i < end - 1; i++)
    if (bytes[i] === BACKSLASH) {
      target.push(JSON.parse(Buffer.from(bytes.subarray(value, end)).toString('utf8')) as string)
      return true
    }
  target.pushUtf8(bytes, value + 1, end - 1)
  return true
}

function stage(spans: Int32Array, at: number, value: number, end: number): void {
  if (at < 0) return
  spans[2 * at] = value
  spans[2 * at + 1] = end
}

/** Visits each item of the array at `open`; `item` returns just past it, or -1 to refuse it.
 *  Returns just past the array, or -1 when it is not one or an item was refused. */
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

/** A JSON number: exact by Clinger's fast path for up to 15 significant digits and a small
 *  exponent, else by the platform's parser; NaN when it is not a JSON number. */
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
  return Number(ASCII.decode(bytes.subarray(start, end)))
}
