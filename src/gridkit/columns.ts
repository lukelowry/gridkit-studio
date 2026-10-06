/** Column chunks and their builders; every column of a table shares one set of chunk boundaries. */

import type {
  BooleanColumn,
  Column as Chunk,
  DataType,
  Index,
  ListColumn,
  NumericArray,
  NumericColumn,
  NumericType,
  ReferenceColumn,
  TextColumn,
  Value,
  VectorColumn,
} from '@latkit/model'
import { failure } from '@latkit/model'

export type { Chunk }

/** Decode once on first use, and release the decoder's source spans afterward. */
export function deferred<T>(decode: () => T): () => T {
  let pending: (() => T) | undefined = decode
  let value: T
  return () => {
    if (pending) {
      value = pending()
      pending = undefined
    }
    return value
  }
}

/** Rows per parsed column chunk. */
export const CHUNK_ROWS = 65_536

export interface Column {
  readonly type: DataType
  readonly chunks: readonly Chunk[]
  /** starts[i] is chunk i's first row; the last entry is the row count. */
  readonly starts: Uint32Array
  /** A reference column's target, kept here so an empty column has it too. */
  readonly index?: Index
  /** Present, non-null JSON, including values rejected by the typed decoder. */
  readonly supplied?: (row: number) => boolean
}

const ARRAYS = {
  float32: Float32Array,
  float64: Float64Array,
  int32: Int32Array,
  uint32: Uint32Array,
}
const ENCODER = new TextEncoder()

export function rowCount(starts: Uint32Array): number {
  return starts[starts.length - 1]!
}

export function chunkAt(starts: Uint32Array, row: number): number {
  let low = 0
  let high = starts.length - 2
  while (low < high) {
    const middle = (low + high + 1) >>> 1
    if (starts[middle]! <= row) low = middle
    else high = middle - 1
  }
  return low
}

export function isValid(chunk: Chunk, at: number): boolean {
  const bits = chunk.validity
  const i = chunk.offset + at
  return bits === undefined || (bits[i >>> 3]! & (1 << (i & 7))) !== 0
}

export function utf8(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start).toString('utf8')
}

/** FNV-1a over bytes [start, end). */
export function hash(bytes: Uint8Array, start: number, end: number): number {
  let h = 0x811c9dc5
  for (let i = start; i < end; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return h >>> 0
}

export function valueAt(chunk: Chunk, at: number): Value {
  if (!isValid(chunk, at)) return null
  const i = chunk.offset + at
  switch (chunk.kind) {
    case 'numeric':
    case 'reference':
      return chunk.values[i]!
    case 'boolean':
      return (chunk.values[i >>> 3]! & (1 << (i & 7))) !== 0
    case 'text':
      return utf8(chunk.bytes, chunk.offsets[i]!, chunk.offsets[i + 1]!)
    case 'vector': {
      const base = chunk.values.offset + i * chunk.size
      return Array.from({ length: chunk.size }, (_, lane) => chunk.values.values[base + lane]!)
    }
    case 'list': {
      const items: Value[] = []
      for (let item = chunk.offsets[i]!; item < chunk.offsets[i + 1]!; item++)
        items.push(valueAt(chunk.values, item))
      return items
    }
  }
}

/** Append-only column builder. */
export interface Builder {
  readonly length: number
  push(value: Value): void
  /** Exactly sized, in its own ArrayBuffer, so it can be published as a borrowed view. */
  finish(): Chunk
}

export function builder(type: DataType, index?: Index): Builder {
  if (typeof type === 'string') {
    if (type === 'text') return new TextBuilder()
    if (type === 'boolean') return new BooleanBuilder()
    return new NumericBuilder(type)
  }
  if (type.kind === 'vector') return new VectorBuilder(type.items, type.size)
  if (type.kind === 'list') return new ListBuilder(type.items)
  if (index === undefined || index.type !== type.to)
    throw failure('internal', `A ${type.to} reference needs its target index.`)
  const build = new NumericBuilder('uint32')
  return {
    get length() {
      return build.length
    },
    push: (value) => build.push(value),
    finish: (): ReferenceColumn => {
      const chunk = build.finish()
      return { ...chunk, kind: 'reference', index, values: chunk.values as Uint32Array }
    },
  }
}

export function chunkOf(type: DataType, values: readonly Value[]): Chunk {
  const build = builder(type)
  for (const value of values) build.push(value)
  return build.finish()
}

/** A growable bitmap, least significant bit first. */
class Bits {
  bytes = new Uint8Array(64)

  set(i: number, on: boolean): void {
    const at = i >>> 3
    if (at >= this.bytes.length) this.grow(at + 1)
    if (on) this.bytes[at]! |= 1 << (i & 7)
    else this.bytes[at]! &= ~(1 << (i & 7))
  }

  grow(bytes: number): void {
    if (bytes <= this.bytes.length) return
    const next = new Uint8Array(Math.max(bytes, this.bytes.length * 2))
    next.set(this.bytes)
    this.bytes = next
  }

  finish(count: number): Uint8Array {
    const out = new Uint8Array(Math.ceil(count / 8))
    out.set(this.bytes.subarray(0, out.length))
    return out
  }
}

/** A bitmap made only once a null arrives. Rows at or past `#filled` are present unless marked. */
class Validity {
  #bits: Bits | null = null
  #filled = 0

  absent(row: number): void {
    this.#fill(row).set(row, false)
    this.#filled = row + 1
  }

  finish(count: number): Uint8Array | undefined {
    if (this.#bits === null) return undefined
    const bytes = this.#fill(count).bytes
    for (let i = 0; i < count; i++)
      if ((bytes[i >>> 3]! & (1 << (i & 7))) === 0) return this.#bits.finish(count)
    return undefined
  }

  #fill(row: number): Bits {
    const bits = (this.#bits ??= new Bits())
    for (let i = this.#filled; i < row; i++) bits.set(i, true)
    this.#filled = Math.max(this.#filled, row)
    return bits
  }
}

export class NumericBuilder implements Builder {
  #values: NumericArray
  #length = 0
  readonly #validity = new Validity()

  constructor(readonly type: NumericType) {
    this.#values = new ARRAYS[type](256)
  }

  get length(): number {
    return this.#length
  }

  pushNumber(value: number): void {
    this.#reserve(1)
    this.#values[this.#length++] = value
  }

  pushNull(): void {
    this.#validity.absent(this.#length)
    this.pushNumber(0)
  }

  push(value: Value): void {
    if (typeof value === 'number') this.pushNumber(value)
    else if (typeof value === 'boolean') this.pushNumber(value ? 1 : 0)
    else this.pushNull()
  }

  finish(): NumericColumn {
    const values = new ARRAYS[this.type](this.#length)
    values.set(this.#values.subarray(0, this.#length))
    const validity = this.#validity.finish(this.#length)
    return {
      kind: 'numeric',
      values,
      offset: 0,
      length: this.#length,
      ...(validity && { validity }),
    }
  }

  #reserve(count: number): void {
    if (this.#length + count <= this.#values.length) return
    const next = new ARRAYS[this.type](Math.max(this.#length + count, this.#values.length * 2))
    next.set(this.#values.subarray(0, this.#length))
    this.#values = next
  }
}

class BooleanBuilder implements Builder {
  readonly #values = new Bits()
  readonly #validity = new Validity()
  #length = 0

  get length(): number {
    return this.#length
  }

  push(value: Value): void {
    if (typeof value !== 'boolean') this.#validity.absent(this.#length)
    this.#values.set(this.#length++, value === true)
  }

  finish(): BooleanColumn {
    const validity = this.#validity.finish(this.#length)
    const values = this.#values.finish(this.#length)
    return {
      kind: 'boolean',
      values,
      offset: 0,
      length: this.#length,
      ...(validity && { validity }),
    }
  }
}

export class TextBuilder implements Builder {
  #bytes = new Uint8Array(1024)
  #offsets = new Int32Array(257)
  #size = 0
  #length = 0
  readonly #validity = new Validity()

  get length(): number {
    return this.#length
  }

  /** UTF-8 bytes [start, end) of `source` as the next cell. */
  pushUtf8(source: Uint8Array, start: number, end: number): void {
    this.#reserve(end - start)
    this.#bytes.set(source.subarray(start, end), this.#size)
    this.#size += end - start
    this.#close()
  }

  pushNull(): void {
    this.#validity.absent(this.#length)
    this.#close()
  }

  push(value: Value): void {
    if (typeof value !== 'string') return this.pushNull()
    this.#reserve(value.length * 3)
    this.#size += ENCODER.encodeInto(value, this.#bytes.subarray(this.#size)).written
    this.#close()
  }

  finish(): TextColumn {
    const bytes = this.#bytes.slice(0, this.#size)
    const offsets = this.#offsets.slice(0, this.#length + 1)
    const validity = this.#validity.finish(this.#length)
    return {
      kind: 'text',
      bytes,
      offsets,
      offset: 0,
      length: this.#length,
      ...(validity && { validity }),
    }
  }

  #close(): void {
    this.#growOffsets()
    this.#offsets[++this.#length] = this.#size
  }

  #growOffsets(): void {
    if (this.#length + 2 <= this.#offsets.length) return
    const next = new Int32Array(this.#offsets.length * 2)
    next.set(this.#offsets)
    this.#offsets = next
  }

  #reserve(count: number): void {
    if (this.#size + count <= this.#bytes.length) return
    const next = new Uint8Array(Math.max(this.#size + count, this.#bytes.length * 2))
    next.set(this.#bytes.subarray(0, this.#size))
    this.#bytes = next
  }
}

export class VectorBuilder implements Builder {
  readonly lanes: NumericBuilder
  readonly #validity = new Validity()
  #length = 0

  constructor(
    items: NumericType,
    readonly size: number,
  ) {
    this.lanes = new NumericBuilder(items)
  }

  get length(): number {
    return this.#length
  }

  pushNull(): void {
    this.#validity.absent(this.#length)
    for (let lane = 0; lane < this.size; lane++) this.lanes.pushNumber(0)
    this.#length++
  }

  push(value: Value): void {
    if (!Array.isArray(value) || value.length !== this.size) return this.pushNull()
    for (const lane of value) this.lanes.pushNumber(lane as number)
    this.#length++
  }

  finish(): VectorColumn {
    const validity = this.#validity.finish(this.#length)
    const values = this.lanes.finish()
    return {
      kind: 'vector',
      size: this.size,
      values,
      offset: 0,
      length: this.#length,
      ...(validity && { validity }),
    }
  }
}

export class ListBuilder implements Builder {
  readonly items: Builder
  #offsets = new Int32Array(257)
  #length = 0
  readonly #validity = new Validity()

  constructor(items: DataType) {
    this.items = builder(items)
  }

  get length(): number {
    return this.#length
  }

  /** Close a cell whose items were pushed to `items`. */
  commit(): void {
    this.#grow()
    this.#offsets[++this.#length] = this.items.length
  }

  pushNull(): void {
    this.#validity.absent(this.#length)
    this.commit()
  }

  push(value: Value): void {
    if (!Array.isArray(value)) return this.pushNull()
    for (const item of value) this.items.push(item)
    this.commit()
  }

  finish(): ListColumn {
    const offsets = this.#offsets.slice(0, this.#length + 1)
    const validity = this.#validity.finish(this.#length)
    const values = this.items.finish()
    return {
      kind: 'list',
      offsets,
      values,
      offset: 0,
      length: this.#length,
      ...(validity && { validity }),
    }
  }

  #grow(): void {
    if (this.#length + 2 <= this.#offsets.length) return
    const next = new Int32Array(this.#offsets.length * 2)
    next.set(this.#offsets)
    this.#offsets = next
  }
}

/** The order that sorts `keys`, stable, in two 16-bit passes. */
export function radixOrder(keys: Uint32Array): Uint32Array {
  let order = Uint32Array.from(keys.keys())
  let next = new Uint32Array(keys.length)
  for (const shift of [0, 16]) {
    const counts = new Uint32Array(65_537)
    for (let i = 0; i < order.length; i++) counts[((keys[order[i]!]! >>> shift) & 0xffff) + 1]!++
    for (let i = 1; i < counts.length; i++) counts[i]! += counts[i - 1]!
    for (let i = 0; i < order.length; i++)
      next[counts[(keys[order[i]!]! >>> shift) & 0xffff]!++] = order[i]!
    ;[order, next] = [next, order]
  }
  return order
}
