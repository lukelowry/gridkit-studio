import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, open } from 'node:fs/promises'
import { basename, dirname, extname, resolve } from 'node:path'
import { Readable } from 'node:stream'

import {
  appendData,
  bitAt,
  blockByteLength,
  type Data,
  type Domain,
  type Index,
  type Query,
  rowAt,
  rowCount,
  selectRows,
  sliceSamples,
} from '@latkit/model'

import type { Case } from '../gridkit/index.js'
import type { Results, Revision, SamplesInput } from '../shared/messages.js'
import type { Frames, ResultCache } from './cache.js'
import {
  chunkFrames,
  columnName,
  type Field,
  type Layout,
  readResults,
  samplesOf,
  selectionsOf,
} from './decode.js'
import { follow, type Piece } from './follow.js'

/** Bytes `start` to `end` of a results file, holding frames `first` up to `first + count`. */
interface Segment {
  start: number
  end: number
  first: number
  count: number
}

/** While a playhead plays, time behind it counts this many times over: views load ahead of it. */
const BEHIND = 4

/** The first of `count` indices where `holds`, which holds at every index after one it holds at;
 *  `count` when it holds at none. */
function firstWhere(count: number, holds: (index: number) => boolean): number {
  let low = 0
  let high = count
  while (low < high) {
    const middle = (low + high) >>> 1
    if (holds(middle)) high = middle
    else low = middle + 1
  }
  return low
}

/** Frames `from` up to `to` of `frames`, as views of their arrays. */
function slice(frames: Frames, from: number, to: number): Data.SampleBatch[] {
  return frames.map((batch) => {
    const at = from - batch.firstFrame
    const rows = rowCount(batch.rows)
    return {
      ...batch,
      firstFrame: from,
      coordinates: batch.coordinates.subarray(at, at + to - from),
      columns: Object.fromEntries(
        Object.entries(batch.columns).map(([name, column]) => [
          name,
          sliceSamples(column, 0, rows, at, to - from),
        ]),
      ),
    }
  })
}

/** `rows`, ascending, as the briefest axis. */
const axisOf = (rows: Uint32Array): Index.Rows =>
  rows.every((row, i) => row === rows[0]! + i)
    ? { kind: 'range', offset: rows[0] ?? 0, count: rows.length }
    : { kind: 'indices', values: rows }

/** The first of `rows`, ascending, at or past `row`. */
function seek(rows: Uint32Array, row: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (rows[middle]! < row) low = middle + 1
    else high = middle
  }
  return low
}

/** `groups`, each the frames after the last, as one batch per field. */
function joined(groups: readonly Frames[]): Frames {
  if (groups.length < 2) return groups[0] ?? []
  const count = groups.reduce((sum, group) => sum + group[0]!.coordinates.length, 0)
  const coordinates = new Float64Array(count)
  let at = 0
  for (const group of groups) {
    coordinates.set(group[0]!.coordinates, at)
    at += group[0]!.coordinates.length
  }
  return groups[0]!.map((head, f) => {
    const rows = rowCount(head.rows)
    const [name] = Object.keys(head.columns)
    const values = new Float64Array(count * rows)
    let into = 0
    for (const group of groups) {
      const column = group[f]!.columns[name!]!
      const cells = group[f]!.coordinates.length * rows
      values.set(column.values.subarray(column.offset, column.offset + cells), into)
      into += cells
    }
    return {
      ...head,
      coordinates,
      columns: {
        [name!]: {
          kind: 'numeric' as const,
          values,
          offset: 0,
          length: values.length,
          frameStride: rows,
          rowStride: 1,
        },
      },
    }
  })
}

/** The results file at `path`, read for `kase` at `revision`, before anything is read of it. */
export function described(
  kase: Case,
  revision: Revision,
  path: string,
  more: Partial<Results> = {},
): Results {
  return {
    id: randomUUID(),
    revision: { uri: revision.uri, version: revision.version },
    fingerprint: kase.version,
    name: basename(path),
    path,
    format: extname(path).toLowerCase() === '.csv' ? 'csv' : 'arrow',
    outputs: [],
    frames: 0,
    domain: [0, 0],
    chunk: 0,
    growing: false,
    started: Date.now(),
    ...more,
  }
}

/** Why results let go of cannot be read: the views ask nothing more of them, and say nothing. */
export const unavailable = () =>
  Object.assign(new Error('These results are no longer read. Open them again.'), {
    code: 'results-unavailable',
  })

/** A GridKit results file read for a case, in chunks of frames that every process cuts alike: the
 *  header's width sets how many frames each holds. The header says what the file holds, whether a
 *  run writes it or it was opened alone. */
export class ResultsFile {
  /** The file as read, in runs of whole frames. */
  readonly #segments: Segment[] = []
  /** Every frame's time. */
  #times = new Float64Array(1024)
  /** The decoded frames of the chunk not yet whole, in order, and those frames as one. */
  #tail: Frames[] = []
  #joined?: { count: number; frames: Frames }
  /** The header's bytes: the CSV header line, or the Arrow schema message. */
  #header: Uint8Array = new Uint8Array()
  /** How every segment of this file reads, from its header. */
  readonly #layout: Layout = {}
  /** Who reads the file now, each done once its promise settles. */
  readonly #leases = new Map<AbortController, Promise<void>>()
  #retired = false
  constructor(
    readonly info: Results,
    readonly kase: Case,
    readonly cache: ResultCache,
  ) {
    // Each reading measures, and learns what it holds, from its own file.
    this.info.domains = {}
    this.info.outputs = []
    this.info.chunk = 0
  }

  /** What the file holds, once its header is read. */
  get fields(): readonly Field[] {
    return this.#layout.read?.fields ?? []
  }

  /** Whether anyone reads the file now. */
  get busy(): boolean {
    return this.#leases.size > 0
  }

  /** Reads the file with `read` until it settles. Retiring the file stops it, and waits for it. */
  async use<R>(signal: AbortSignal, read: (signal: AbortSignal) => Promise<R>): Promise<R> {
    signal.throwIfAborted()
    if (this.#retired) throw unavailable()
    const lease = new AbortController()
    let done!: () => void
    this.#leases.set(lease, new Promise<void>((resolve) => (done = resolve)))
    try {
      return await read(AbortSignal.any([signal, lease.signal]))
    } finally {
      this.#leases.delete(lease)
      done()
    }
  }

  /** Stops whoever reads the file, waits for them, and lets go of its chunks. The file stays. */
  async retire(): Promise<void> {
    this.#retired = true
    const leases = [...this.#leases]
    for (const [lease] of leases) lease.abort(unavailable())
    await Promise.all(leases.map(([, done]) => done))
    this.release()
  }

  /** Follows the results file as the run writes it, reading each segment as it comes, and tells
   *  `progress` after each. Returns once `ended` and the file has nothing more. */
  async ingest(signal: AbortSignal, ended: () => boolean, progress: () => Promise<void> | void) {
    for await (const piece of follow(this.info.path, this.info.format, signal, ended)) {
      if (piece.kind === 'header') await this.#learn(piece.bytes, signal)
      else {
        await this.#append(piece, signal)
        await progress()
      }
    }
  }

  /** The first frame time after `at`, or the last before it when `direction` is -1: the first or
   *  last time when there is none. */
  step(at: number, direction: -1 | 1): number {
    const { frames, domain } = this.info
    const times = this.#times
    if (direction > 0) {
      const next = firstWhere(frames, (i) => times[i]! > at)
      return next === frames ? domain[1] : times[next]!
    }
    const previous = firstWhere(frames, (i) => times[i]! >= at) - 1
    return previous < 0 ? domain[0] : times[previous]!
  }

  /** The case's data with the chunks whose frames reach over `window`: of the fields of type
   *  `from`, as a query of its rows reads, else of every field. */
  async data(window: Domain, signal: AbortSignal, from?: string): Promise<Data> {
    const { chunk } = this.info
    const fields = from
      ? this.fields.flatMap((field, f) => (field.index.type === from ? [f] : []))
      : undefined
    const [first, end] = this.#span(window)
    let data = this.kase.data
    for (let k = Math.floor(first / chunk); chunk && k * chunk < end; k++)
      data = appendData(data, await this.#chunk(k, signal, fields))
    return data
  }

  /** What a view lacks of one field over a window: the frames of each chunk that reaches it past
   *  those the view holds, nearest first when asked, to about `bytes`. */
  async samples(
    { field, window, held, near, bytes }: SamplesInput,
    signal: AbortSignal,
  ): Promise<Data.SampleBatch[]> {
    const { chunk, frames } = this.info
    const f = this.#fieldOf(field)
    if (!chunk || f < 0) return []
    const [first, end] = this.#span(window)
    const chunks: number[] = []
    for (let k = Math.floor(first / chunk); k * chunk < end; k++) chunks.push(k)
    if (near) chunks.sort((a, b) => this.#distance(a, near) - this.#distance(b, near))
    const reply: Data.SampleBatch[] = []
    let size = 0
    for (const k of chunks) {
      const from = k * chunk + (held[k] ?? 0)
      const to = Math.min(frames, (k + 1) * chunk)
      if (from >= to) continue
      if (reply.length && size >= bytes) break
      const batch = this.#pick(slice(await this.#chunk(k, signal, [f]), from, to), field)
      if (!batch) continue
      reply.push(batch)
      size += blockByteLength([batch])
    }
    return reply
  }

  /** Where `from`'s `select`ed field is among those the file holds; -1 where it holds none. */
  #fieldOf({ from, select: [name] }: Query.Selection): number {
    return this.fields.findIndex((field) => field.index.type === from && field.name === name)
  }

  /** `frames`' samples of `field`: the rows of it the file holds, or those of them it names, as one
   *  batch of arrays of its own, to send. */
  #pick(
    frames: Frames,
    { from, select: [name], rows }: Query.Selection,
  ): Data.SampleBatch | undefined {
    const batch = frames.find((each) => each.index.type === from && name! in each.columns)
    const held = this.fields.find((field) => field.index.type === from && field.name === name)
    if (!batch || !held) return undefined
    const column = batch.columns[name!]!
    // Where each row sent sits among those the file holds.
    let places: Uint32Array | undefined
    if (rows) {
      const wanted = selectRows(this.kase.data.tables[from]!, rows)
      const found: number[] = []
      for (let i = 0; i < rowCount(wanted); i++) {
        const place = seek(held.rows, rowAt(wanted, i))
        if (held.rows[place] === rowAt(wanted, i)) found.push(place)
      }
      places = Uint32Array.from(found.sort((a, b) => a - b))
    }
    const width = places?.length ?? held.rows.length
    if (!width) return undefined
    const count = batch.coordinates.length
    const values = new Float64Array(count * width)
    for (let t = 0; t < count; t++)
      for (let r = 0; r < width; r++)
        values[t * width + r] =
          column.values[
            column.offset + t * column.frameStride + (places?.[r] ?? r) * column.rowStride
          ]!
    return {
      kind: 'samples',
      index: batch.index,
      // The reply's arrays move to the extension, so the rows it names are a copy, never the field's own.
      rows: places
        ? axisOf(places.map((place) => held.rows[place]!))
        : held.axis.kind === 'indices'
          ? { kind: 'indices', values: held.axis.values.slice() }
          : held.axis,
      firstFrame: batch.firstFrame,
      coordinates: batch.coordinates.slice(),
      columns: {
        [name!]: {
          kind: 'numeric',
          values,
          offset: 0,
          length: values.length,
          frameStride: width,
          rowStride: 1,
        },
      },
    }
  }

  async exportCsv(path: string, signal: AbortSignal) {
    if (resolve(path) === resolve(this.info.path))
      throw new Error('Choose a different file from the open results.')
    await mkdir(dirname(path), { recursive: true })
    if (this.info.format === 'csv') return copyFile(this.info.path, path)
    const file = await open(path, 'w')
    try {
      const names = [
        'time',
        ...this.fields.flatMap((field) => {
          const table = this.kase.table(field.index.type)
          return Array.from(field.rows, (row) => columnName(this.kase, table, row, field.name))
        }),
      ]
      await file.write(names.map((n) => '"' + n.replaceAll('"', '""') + '"').join(',') + '\n')
      const { chunk, frames } = this.info
      for (let k = 0; chunk && k * chunk < frames; k++) {
        const fields = await this.#chunk(k, signal)
        const [first] = fields
        for (let t = 0; first && t < first.coordinates.length; t++) {
          const values = fields.flatMap((batch) =>
            Object.values(batch.columns).flatMap((column) =>
              Array.from(
                { length: rowCount(batch.rows) },
                (_, r) =>
                  column.values[column.offset + t * column.frameStride + r * column.rowStride]!,
              ),
            ),
          )
          await file.write([first.coordinates[t], ...values].join(',') + '\n')
        }
      }
    } finally {
      await file.close()
    }
  }

  /** Drops the file's cached chunks. */
  release() {
    this.cache.drop(this.info.id + ':')
  }

  /** Keeps the file's header, which a CSV file's segments are read with. Read alone, it gives the
   *  layout every segment is read with. */
  async #learn(header: Uint8Array, signal: AbortSignal) {
    this.#header = header
    if (this.info.format !== 'csv') return
    await readResults(
      Readable.from([header]),
      this.kase,
      { signal, publish: () => {} },
      'csv',
      this.#layout,
    )
    this.#learned()
  }

  /** Tells the views, through `info`, what the file holds and how it is cut, once its header says. */
  #learned() {
    if (this.info.outputs.length || !this.fields.length) return
    this.info.outputs = selectionsOf(this.fields)
    this.info.chunk = chunkFrames(this.fields)
  }

  /** The frames whose samples reach over `[a, b]`: from the last at or before `a` up to the first
   *  at or after `b`, as a frame and the frame past the last. */
  #span([a, b]: Domain): [number, number] {
    const { frames } = this.info
    if (!frames) return [0, 0]
    const times = this.#times
    const first = Math.max(0, firstWhere(frames, (i) => times[i]! > a) - 1)
    const last = Math.min(
      frames - 1,
      firstWhere(frames, (i) => times[i]! >= b),
    )
    return [first, Math.max(first, last) + 1]
  }

  /** How far chunk `k`'s times lie from `at`; while a playhead plays, time behind it counts more. */
  #distance(k: number, { at, travel }: { at: number; travel: number }): number {
    const { chunk, frames } = this.info
    const start = this.#times[k * chunk]!
    const end = this.#times[Math.min(frames, (k + 1) * chunk) - 1]!
    if (at < start) return (start - at) * (travel < 0 ? BEHIND : 1)
    if (at > end) return (at - end) * (travel > 0 ? BEHIND : 1)
    return 0
  }

  /** The cache's key for field `f` of chunk `k`. Each field of a chunk is kept apart, so a view's
   *  field is decoded alone, and the fields views read stay as the rest go. */
  #keyOf(k: number, f: number): string {
    return `${this.info.id}:${k}:${f}`
  }

  /** Chunk `k`'s frames read so far of `fields`, by their place among the file's, one batch each;
   *  of every field when none are named. A whole chunk's field comes from the cache, or is decoded
   *  again into it from the segments that hold it, with only the fields missing read as numbers. */
  async #chunk(k: number, signal: AbortSignal, fields?: readonly number[]): Promise<Frames> {
    const { chunk, frames } = this.info
    if (k * chunk >= frames) return []
    const wanted = fields ?? this.fields.map((_, f) => f)
    if ((k + 1) * chunk > frames) {
      if (this.#joined?.count !== frames)
        this.#joined = { count: frames, frames: joined(this.#tail) }
      const tail = this.#joined.frames
      return tail.length ? wanted.map((f) => tail[f]!) : []
    }
    const found = new Map<number, Data.SampleBatch>()
    for (const f of wanted) {
      const cached = this.cache.get(this.#keyOf(k, f))?.[0]
      if (cached) found.set(f, cached)
    }
    const missing = wanted.filter((f) => !found.has(f))
    if (missing.length) {
      // Groups never cross a chunk, so each lands with its own. Every chunk the segments read hold
      // whole is kept, so a segment longer than a chunk, as an Arrow batch can be, decodes once.
      const groups = new Map<number, Frames[]>()
      const [first, end] = [k * chunk, (k + 1) * chunk]
      let from = Infinity
      let to = -Infinity
      for (const segment of this.#segments) {
        if (segment.first + segment.count <= first || segment.first >= end) continue
        from = Math.min(from, segment.first)
        to = Math.max(to, segment.first + segment.count)
        await this.#decode(
          await this.#read(segment.start, segment.end),
          segment.first,
          signal,
          (group) => {
            const j = Math.floor(group[0]!.firstFrame / chunk)
            const held = groups.get(j)
            if (held) held.push(group)
            else groups.set(j, [group])
          },
          missing,
        )
      }
      for (const [j, held] of groups)
        if (j === k || (j * chunk >= from && (j + 1) * chunk <= Math.min(to, frames))) {
          const whole = joined(held)
          missing.forEach((f, i) => {
            const batch = whole[i]
            if (!batch) return
            this.cache.put(this.#keyOf(j, f), [batch])
            if (j === k) found.set(f, batch)
          })
        }
    }
    return wanted.flatMap((f) => found.get(f) ?? [])
  }

  /** Decodes `bytes`, whose first frame is `first`, handing `publish` each group of frames: one
   *  batch per field, of `only` when given, never crossing into the next chunk. A CSV segment is
   *  rows alone, read with the layout its header gave; an Arrow batch is read after the schema. */
  async #decode(
    bytes: Uint8Array,
    first: number,
    signal: AbortSignal,
    publish: (group: Frames) => void,
    only?: readonly number[],
  ) {
    await readResults(
      Readable.from(this.info.format === 'csv' ? [bytes] : [this.#header, bytes]),
      this.kase,
      {
        signal,
        first,
        ...(only && { only }),
        publish: (frames) => publish(samplesOf(this.fields, frames, only)),
      },
      this.info.format,
      this.#layout,
    )
    this.#learned()
  }

  async #read(start: number, end: number): Promise<Uint8Array> {
    const file = await open(this.info.path, 'r')
    try {
      const bytes = new Uint8Array(end - start)
      let read = 0
      while (read < bytes.length) {
        const { bytesRead } = await file.read(bytes, read, bytes.length - read, start + read)
        if (!bytesRead) throw new Error('Result file changed while being read.')
        read += bytesRead
      }
      return bytes
    } finally {
      await file.close()
    }
  }

  /** Reads the segment between `start` and `end`, `bytes`: each group of its frames in turn. */
  async #append({ start, end, bytes }: Extract<Piece, { kind: 'segment' }>, signal: AbortSignal) {
    const first = this.info.frames
    await this.#decode(bytes, first, signal, (group) => this.#add(group))
    const count = this.info.frames - first
    if (count) this.#segments.push({ start, end, first, count })
  }

  /** Takes in `group`, the next frames read: their times, the ranges of their values, and the chunk
   *  they fill. A whole chunk goes to the cache: the frames ingested are decoded once. */
  #add(group: Frames) {
    const times = group[0]?.coordinates
    if (!times?.length) return
    // The header was read before any frame.
    this.#learned()
    const { frames } = this.info
    if (times[0]! < (frames ? this.#times[frames - 1]! : -Infinity))
      throw new Error('Result times must be nondecreasing.')
    if (frames + times.length > this.#times.length) {
      const grown = new Float64Array(Math.max(2 * this.#times.length, frames + times.length))
      grown.set(this.#times.subarray(0, frames))
      this.#times = grown
    }
    this.#times.set(times, frames)
    // Measured once, as frames are read: every view uses these ranges, and scrubbing never
    // rescans history or normalizes one frame.
    const domains = (this.info.domains ??= {})
    for (const batch of group) {
      const fields = (domains[batch.index.type] ??= {})
      const rows = rowCount(batch.rows)
      for (const [name, column] of Object.entries(batch.columns)) {
        let [min, max] = fields[name] ?? [Infinity, -Infinity]
        for (let frame = 0; frame < batch.coordinates.length; frame++)
          for (let row = 0; row < rows; row++) {
            const at = column.offset + frame * column.frameStride + row * column.rowStride
            const value = column.values[at]!
            if (!bitAt(column.validity, at) || !Number.isFinite(value)) continue
            min = Math.min(min, value)
            max = Math.max(max, value)
          }
        if (min <= max) fields[name] = [min, max]
      }
    }
    this.info.frames = frames + times.length
    this.info.domain = [this.#times[0]!, times.at(-1)!]
    this.#tail.push(group)
    const { chunk } = this.info
    if (this.info.frames % chunk === 0) {
      const k = this.info.frames / chunk - 1
      joined(this.#tail).forEach((batch, f) => this.cache.put(this.#keyOf(k, f), [batch]))
      this.#tail = []
      this.#joined = undefined
    }
  }
}
