/** Decode native results into one reused staging area; never accumulate a run. */
import { addAbortSignal, type Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'

import { failure, type SampleBatch } from '@latkit/model'

import type { Case, Table } from '../gridkit/case.js'
import type { Field } from '../gridkit/parameters.js'
import { type ArrowField, messages } from './arrow.js'
import { csvMessages } from './csv.js'
import { BATCH_BYTES } from './limits.js'

export type ResultFormat = 'arrow' | 'csv'
/** Decoded frames. Views are borrowed until `publish` settles, then overwritten. */
export interface Frames {
  readonly firstFrame: number
  readonly count: number
  readonly coordinates: Float64Array
  /** Per output field, `count` frames of its rows, frame-major. */
  readonly values: readonly Float64Array[]
}
export interface Reading {
  readonly signal: AbortSignal
  /** connect's publish resolves after copying into its frame; other consumers copy what they keep. */
  readonly publish: (frames: Frames) => void | Promise<void>
}
export interface Plan {
  readonly doubles: Uint8Array
  readonly columns: readonly Int32Array[]
  readonly strides: Int32Array
}
/** How a run's results read, learned from their header once: its columns, and the column each
 *  output's row reads. Every page after the first reuses it, so a wide run is not matched name by
 *  name again for each of its frames. */
export interface Layout {
  fields?: readonly ArrowField[]
  plan?: Plan
}

/** One sample batch per output field over the same frames; connect sizes them for the wire. */
export function samplesOf(fields: readonly Field[], frames: Frames): SampleBatch[] {
  return fields.map((field, f) => {
    const values = frames.values[f]!
    return {
      kind: 'samples',
      index: field.index,
      rows: field.axis,
      firstFrame: frames.firstFrame,
      coordinates: frames.coordinates,
      columns: {
        [field.name]: {
          kind: 'numeric',
          values,
          offset: 0,
          length: values.length,
          frameStride: field.rows.length,
          rowStride: 1,
        },
      },
    }
  })
}

export async function readResults(
  source: Readable,
  outputs: readonly Field[],
  kase: Case,
  reading: Reading,
  format: ResultFormat = 'arrow',
  batchRows = 64,
  layout: Layout = {},
): Promise<{ readonly frames: number }> {
  let plan: Plan | undefined
  let received = 0
  let lastTime = -Infinity
  let yielded = performance.now()
  const frameBytes = 8 * (1 + outputs.reduce((n, field) => n + field.rows.length, 0))
  if (frameBytes > BATCH_BYTES)
    throw failure('resource-limit', 'One selected frame exceeds the batch budget.')
  const perBatch = Math.max(1, Math.floor(BATCH_BYTES / frameBytes))
  const staging = new Staging(outputs.map((field) => field.rows.length))
  try {
    reading.signal.throwIfAborted()
    const chunks = addAbortSignal(reading.signal, source)
    for await (const message of format === 'csv'
      ? csvMessages(chunks, batchRows, layout.fields)
      : messages(chunks)) {
      reading.signal.throwIfAborted()
      if (message.kind === 'schema') {
        if (plan) throw failure('io', 'The results repeat their schema.')
        layout.fields ??= message.fields
        plan = layout.plan ??= placementOf(message.fields, outputs, kase)
        continue
      }
      if (!plan) throw failure('io', 'The results hold a batch before their schema.')
      const length = message.kind === 'rows' ? message.length : message.batch.length
      if (!Number.isSafeInteger(length) || length < 0)
        throw failure('io', 'Invalid result batch length.')
      if (!Number.isSafeInteger(received + length))
        throw failure('resource-limit', 'The results contain too many frames.')
      const decoded =
        message.kind === 'batch'
          ? arrowInput(message.body, message.batch.buffers, length, plan)
          : undefined
      for (let from = 0; from < length; from += perBatch) {
        reading.signal.throwIfAborted()
        const count = Math.min(perBatch, length - from)
        const time = decoded?.times
        for (let t = from; t < from + count; t++) {
          const value = message.kind === 'rows' ? message.values[t * message.width]! : time![t]!
          if (!Number.isFinite(value) || value < lastTime)
            throw failure('io', 'Result times must be finite and nondecreasing.')
          lastTime = value
        }
        // Without outputs, times are still checked and counted.
        if (!outputs.length) continue
        const { coordinates, values } = staging.take(count)
        if (message.kind === 'rows') {
          for (let t = 0; t < count; t++)
            coordinates[t] = message.values[(from + t) * message.width]!
          copyRows(message.values, message.width, plan, values, from, count)
        } else {
          coordinates.set(time!.subarray(from, from + count))
          copyColumns(decoded!, values, from, count)
        }
        const published = reading.publish({
          firstFrame: received + from,
          count,
          coordinates,
          values,
        })
        if (published !== undefined) await published
      }
      received += length
      // Give sockets and cancellation a turn without scheduling every tiny result batch.
      if (performance.now() - yielded >= 4) {
        await setImmediate(undefined, { signal: reading.signal })
        yielded = performance.now()
      }
    }
    if (!plan) throw failure('io', 'The results contain no schema.')
    return { frames: received }
  } catch (error) {
    reading.signal.throwIfAborted()
    throw error
  }
}

/** One run's sample staging, grown to its largest batch and reused for every batch after it.
 *  The copy kernels write every cell, so no batch reads values left by an earlier one. */
class Staging {
  #coordinates = new Float64Array(0)
  #values: Float64Array[] = []
  constructor(private readonly widths: readonly number[]) {}

  take(count: number): Pick<Frames, 'coordinates' | 'values'> {
    if (count > this.#coordinates.length) {
      this.#coordinates = new Float64Array(count)
      this.#values = this.widths.map((width) => new Float64Array(count * width))
    }
    return {
      coordinates: this.#coordinates.subarray(0, count),
      values: this.#values.map((cells, f) => cells.subarray(0, count * this.widths[f]!)),
    }
  }
}

interface ArrowInput {
  readonly body: Float64Array
  readonly decoded: Float64Array
  readonly starts: readonly Int32Array[]
  readonly times: Float64Array
  readonly frames: number
}

/** Plain native doubles stay in one body view; only float32/null columns need scratch decoding. */
function arrowInput(
  body: Uint8Array,
  buffers: Float64Array,
  frames: number,
  plan: Plan,
): ArrowInput {
  const doubles = new Float64Array(body.buffer, body.byteOffset, body.byteLength >>> 3)
  const regions = new Map<number, number>()
  const startOf = (column: number): number => {
    if (column >= 0) {
      const offset = buffers[4 * column + 2]!
      const bytes = buffers[4 * column + 3]!
      const bitOffset = buffers[4 * column]!
      const bitBytes = buffers[4 * column + 1]!
      const width = plan.doubles[column] === 1 ? 8 : 4
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset % 8 !== 0 ||
        !Number.isSafeInteger(bytes) ||
        bytes < width * frames ||
        offset + bytes > body.byteLength ||
        !Number.isSafeInteger(bitBytes) ||
        bitBytes < 0 ||
        (bitBytes > 0 &&
          (!Number.isSafeInteger(bitOffset) ||
            bitOffset < 0 ||
            bitBytes < Math.ceil(frames / 8) ||
            bitOffset + bitBytes > body.byteLength))
      )
        throw failure('io', 'The results hold a batch whose buffers are out of place.')
      if (width === 8 && bitBytes === 0) return offset / 8
    }
    let region = regions.get(column)
    if (region === undefined) regions.set(column, (region = regions.size))
    return -1 - region
  }
  const clock = startOf(0)
  const starts = plan.columns.map((columns) => Int32Array.from(columns, startOf))
  const decoded = new Float64Array(regions.size * frames)
  for (const [column, region] of regions) {
    const into = decoded.subarray(region * frames, (region + 1) * frames)
    if (column < 0) {
      into.fill(NaN)
      continue
    }
    const offset = body.byteOffset + buffers[4 * column + 2]!
    into.set(
      plan.doubles[column] === 1
        ? new Float64Array(body.buffer, offset, frames)
        : new Float32Array(body.buffer, offset, frames),
    )
    const bitBytes = buffers[4 * column + 1]!
    if (bitBytes) {
      const bitOffset = buffers[4 * column]!
      for (let t = 0; t < frames; t++)
        if ((body[bitOffset + (t >>> 3)]! & (1 << (t & 7))) === 0) into[t] = NaN
    }
  }
  return {
    body: doubles,
    decoded,
    starts,
    frames,
    times:
      clock >= 0
        ? doubles.subarray(clock, clock + frames)
        : decoded.subarray((-1 - clock) * frames, -clock * frames),
  }
}

function copyColumns(
  input: ArrowInput,
  fields: readonly Float64Array[],
  from: number,
  count: number,
): void {
  for (let f = 0; f < fields.length; f++) {
    const starts = input.starts[f]!
    const values = fields[f]!
    const rows = starts.length
    for (let row = 0; row < rows; row++) {
      const start = starts[row]!
      const cells = start >= 0 ? input.body : input.decoded
      const base = (start >= 0 ? start : (-1 - start) * input.frames) + from
      for (let t = 0; t < count; t++) values[t * rows + row] = cells[base + t]!
    }
  }
}

function copyRows(
  source: Float64Array,
  width: number,
  plan: Plan,
  fields: readonly Float64Array[],
  from: number,
  count: number,
): void {
  for (let f = 0; f < fields.length; f++) {
    const placed = plan.columns[f]!
    const values = fields[f]!
    const rows = placed.length
    const stride = plan.strides[f]!
    if (stride >= 0) {
      // Native channels are usually interleaved regularly; walk both buffers forwards.
      let into = 0
      for (let t = 0; t < count; t++) {
        let at = (from + t) * width + placed[0]!
        for (let row = 0; row < rows; row++, at += stride) values[into++] = source[at]!
      }
      continue
    }
    for (let row = 0; row < rows; row++) {
      const column = placed[row]!
      if (column < 0) {
        for (let t = 0; t < count; t++) values[t * rows + row] = NaN
      } else {
        const base = from * width + column
        for (let t = 0; t < count; t++) values[t * rows + row] = source[base + t * width]!
      }
    }
  }
}

/** A row's column: `<class>_<identity>_<output>`, a bus by its name. */
function columnName(kase: Case, table: Table, row: number, output: string): string {
  const identity =
    table.shape.kind === 'bus' ? kase.cell(table, 'name', row) : kase.native(table, row)
  return `${table.shape.type}_${identity}_${output}`
}

/** Match complete names case-insensitively; repeated names consume rows in order. */
function placementOf(fields: readonly ArrowField[], outputs: readonly Field[], kase: Case): Plan {
  if (fields.length === 0) throw failure('io', 'The results do not start with a time column.')
  const places = new Map<string, { readonly field: number; readonly position: number }[]>()
  outputs.forEach((field, f) => {
    const table = kase.table(field.index.type)
    field.rows.forEach((row, position) => {
      const name = fold(columnName(kase, table, row, field.name))
      const list = places.get(name)
      if (list === undefined) places.set(name, [{ field: f, position }])
      else list.push({ field: f, position })
    })
  })
  const doubles = new Uint8Array(fields.length)
  const columns = outputs.map((field) => new Int32Array(field.rows.length).fill(-1))
  const taken = new Map<string, number>()
  fields.forEach((field, column) => {
    doubles[column] = field.type === 'float64' ? 1 : 0
    if (column === 0) return
    const name = fold(field.name)
    const count = taken.get(name) ?? 0
    taken.set(name, count + 1)
    const place = places.get(name)?.[count]
    if (place !== undefined) columns[place.field]![place.position] = column
  })
  const strides = Int32Array.from(columns, (placed) => {
    const first = placed[0] ?? -1
    const stride = placed.length > 1 ? placed[1]! - first : 0
    return first >= 0 &&
      stride >= 0 &&
      placed.every((column, row) => column === first + row * stride)
      ? stride
      : -1
  })
  return { doubles, columns, strides }
}

function fold(name: string): string {
  return name.normalize('NFC').toLowerCase()
}
