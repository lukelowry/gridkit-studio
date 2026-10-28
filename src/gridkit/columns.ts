/** Lazy parser columns use native scalar arrays; no renderer row-space lives here. */
import type { Geometry, Values } from 'latkit'

import type { Value } from '../shared/messages.js'

export type DecodeKind = 'number' | 'integer' | 'unsigned' | 'boolean' | 'text' | 'path' | 'json'
export type Chunk = Float64Array | (string | null)[] | (boolean | null)[] | (Geometry | null)[]
export interface Column {
  readonly kind: DecodeKind | 'reference'
  readonly chunks: readonly Chunk[]
  readonly starts: Uint32Array
  readonly target?: string
  readonly provided?: () => boolean
  readonly wrong?: () => readonly number[]
}
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
export const CHUNK_ROWS = 65_536
export const isInt32 = (value: number) =>
  Number.isInteger(value) && value >= -0x8000_0000 && value <= 0x7fff_ffff
export const rowCount = (starts: Uint32Array) => starts[starts.length - 1]!
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
  const value = chunk[at]
  return (
    value !== null && value !== undefined && (typeof value !== 'number' || Number.isFinite(value))
  )
}
export function valueAt(chunk: Chunk, at: number): Value {
  return isValid(chunk, at) ? (chunk[at] as Value) : null
}
export function utf8(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start).toString('utf8')
}
export function hash(bytes: Uint8Array, start: number, end: number): number {
  let h = 0x811c9dc5
  for (let i = start; i < end; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return h >>> 0
}
/** Copy only requested rows; cached parser buffers never cross a transfer boundary. */
export function readColumn(column: Column, offset: number, count: number): Values {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(count) ||
    offset < 0 ||
    count < 0 ||
    offset + count > rowCount(column.starts)
  )
    throw new Error('A column read exceeds its source rows.')
  const numeric = ['number', 'integer', 'unsigned', 'reference'].includes(column.kind)
  const result = numeric ? new Float64Array(count).fill(NaN) : new Array(count).fill(null)
  let written = 0
  while (written < count) {
    const chunk = chunkAt(column.starts, offset + written)
    const from = offset + written - column.starts[chunk]!
    const values = column.chunks[chunk]!
    const length = Math.min(count - written, values.length - from)
    for (let i = 0; i < length; i++) result[written + i] = values[from + i]
    written += length
  }
  return result
}
export interface Builder {
  readonly length: number
  push(value: Value): void
  finish(): Chunk
}
export function builder(kind: DecodeKind): Builder {
  if (kind === 'text' || kind === 'json') return new TextBuilder()
  if (kind === 'boolean') return new BooleanBuilder()
  if (kind === 'path') return new PathBuilder()
  return new NumericBuilder()
}
export function chunkOf(kind: DecodeKind, values: readonly Value[]): Chunk {
  const target = builder(kind)
  for (const value of values) target.push(value)
  return target.finish()
}
export class NumericBuilder implements Builder {
  #values = new Float64Array(256)
  #length = 0
  get length(): number {
    return this.#length
  }
  pushNumber(value: number): void {
    if (this.#length === this.#values.length) {
      const next = new Float64Array(this.#values.length * 2)
      next.set(this.#values)
      this.#values = next
    }
    this.#values[this.#length++] = value
  }
  pushNull(): void {
    this.pushNumber(NaN)
  }
  push(value: Value): void {
    this.pushNumber(typeof value === 'number' ? value : NaN)
  }
  finish(): Float64Array {
    return this.#values.slice(0, this.#length)
  }
}
class BooleanBuilder implements Builder {
  readonly #values: (boolean | null)[] = []
  get length(): number {
    return this.#values.length
  }
  push(value: Value): void {
    this.#values.push(typeof value === 'boolean' ? value : null)
  }
  finish(): (boolean | null)[] {
    return this.#values.slice()
  }
}
export class TextBuilder implements Builder {
  readonly #values: (string | null)[] = []
  get length(): number {
    return this.#values.length
  }
  pushUtf8(source: Uint8Array, start: number, end: number): void {
    this.#values.push(utf8(source, start, end))
  }
  pushNull(): void {
    this.#values.push(null)
  }
  push(value: Value): void {
    this.#values.push(typeof value === 'string' ? value : null)
  }
  finish(): (string | null)[] {
    return this.#values.slice()
  }
}
class PathBuilder implements Builder {
  readonly #values: (Geometry | null)[] = []
  get length(): number {
    return this.#values.length
  }
  push(value: Value): void {
    this.#values.push(Array.isArray(value) ? (value as Geometry) : null)
  }
  finish(): (Geometry | null)[] {
    return this.#values.slice()
  }
}
/** Stable unsigned-key ordering in two 16-bit passes, for source identity validation. */
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
