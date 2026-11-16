/** Lazily decoded parser columns in typed and plain arrays. Nothing here is renderer-specific. */
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
/** Whether `value` is a valid GridKit id (a size_t): a non-negative integer a double represents
 *  exactly. */
export const isId = (value: number) => Number.isSafeInteger(value) && value >= 0
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
/** A copy of `array` with twice the length. */
export function grown<T extends Int32Array | Uint32Array | Float64Array>(array: T): T {
  const next = new (array.constructor as new (length: number) => T)(array.length * 2)
  next.set(array)
  return next
}
export function hash(bytes: Uint8Array, start: number, end: number): number {
  let h = 0x811c9dc5
  for (let i = start; i < end; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return h >>> 0
}
/** Copies only the requested rows, so cached parser buffers never cross a transfer boundary. */
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
  push(value: Value): void
  finish(): Chunk
}
export function builder(kind: DecodeKind): Builder {
  if (kind === 'text' || kind === 'json') return new TextBuilder()
  if (kind === 'boolean') return new BooleanBuilder()
  if (kind === 'path') return new PathBuilder()
  return new NumericBuilder()
}
export class NumericBuilder implements Builder {
  #values = new Float64Array(256)
  #length = 0
  pushNumber(value: number): void {
    if (this.#length === this.#values.length) this.#values = grown(this.#values)
    this.#values[this.#length++] = value
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
  push(value: Value): void {
    this.#values.push(typeof value === 'boolean' ? value : null)
  }
  finish(): (boolean | null)[] {
    return this.#values.slice()
  }
}
export class TextBuilder implements Builder {
  readonly #values: (string | null)[] = []
  push(value: Value): void {
    this.#values.push(typeof value === 'string' ? value : null)
  }
  finish(): (string | null)[] {
    return this.#values.slice()
  }
}
class PathBuilder implements Builder {
  readonly #values: (Geometry | null)[] = []
  push(value: Value): void {
    this.#values.push(Array.isArray(value) ? (value as Geometry) : null)
  }
  finish(): (Geometry | null)[] {
    return this.#values.slice()
  }
}
