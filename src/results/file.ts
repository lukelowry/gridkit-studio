import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { Readable } from 'node:stream'

import {
  appendData,
  blockByteLength,
  type Data,
  type Domain,
  type Index,
  type Query,
  rowAt,
  rowCount,
  selectRows,
} from '@latkit/model'

import type { Case } from '../gridkit/index.js'
import { message, problem } from '../shared/errors.js'
import type { ResultsLayout, ResultsProgress, Revision, SamplesInput } from '../shared/messages.js'
import type { Frames, ResultCache } from './cache.js'
import {
  axisOf,
  chunkFrames,
  type Decoded,
  type Field,
  type Layout,
  layoutFrom,
  readResults,
  samplesOf,
  selectionsOf,
} from './decode.js'
import { follow, type Writer } from './follow.js'
import { fileKey, type Store } from './store.js'

/** While a playhead plays, time behind it counts this many times over: views load ahead of it. */
const BEHIND = 4
/** Times are kept in pages of about this many frames, each a whole number of chunks: a chunk's
 *  times are part of one page, which every batch of the chunk shares. */
const PAGE_FRAMES = 1 << 16
/** How many frames' times a file's first page holds before it grows. */
const FIRST_TIMES = 1024

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

/** Every frame's time, in pages of a whole number of chunks. The last page grows as frames come,
 *  to its whole size: times a view took of it before stay as they were, as times never change. */
class Times {
  readonly #pages: Float64Array[] = []
  readonly #page: number
  #count = 0

  constructor(chunk: number) {
    this.#page = chunk * Math.max(1, Math.ceil(PAGE_FRAMES / chunk))
  }

  /** The bytes its pages take. */
  get bytes(): number {
    return this.#pages.reduce((bytes, page) => bytes + page.byteLength, 0)
  }

  at(frame: number): number {
    return this.#pages[Math.floor(frame / this.#page)]![frame % this.#page]!
  }

  push(times: Float64Array): void {
    for (let from = 0; from < times.length;) {
      const p = Math.floor(this.#count / this.#page)
      const at = this.#count % this.#page
      const count = Math.min(times.length - from, this.#page - at)
      let page = this.#pages[p] ?? new Float64Array(0)
      if (page.length < at + count) {
        const grown = new Float64Array(
          Math.min(this.#page, Math.max(FIRST_TIMES, 2 * page.length, at + count)),
        )
        grown.set(page.subarray(0, at))
        this.#pages[p] = page = grown
      }
      page.set(times.subarray(from, from + count), at)
      from += count
      this.#count += count
    }
  }

  /** The times of frames `first` up to `first + count`, which one chunk holds: part of one page. */
  of(first: number, count: number): Float64Array {
    const at = first % this.#page
    return this.#pages[Math.floor(first / this.#page)]!.subarray(at, at + count)
  }

  /** Every time, as one array. */
  all(): Float64Array {
    const times = new Float64Array(this.#count)
    this.#pages.forEach((page, p) =>
      times.set(
        page.subarray(0, Math.min(this.#page, this.#count - p * this.#page)),
        p * this.#page,
      ),
    )
    return times
  }
}

/** Frames `from` up to `to` of `batch`'s field `name`, of the rows at `places` among those it holds
 *  (every one when absent), named as `rows`: arrays of their own, frame by frame, to send. */
function copied(
  batch: Data.SampleBatch,
  name: string,
  from: number,
  to: number,
  rows: Index.Rows,
  places?: Uint32Array,
): Data.SampleBatch {
  const column = batch.columns[name]!
  const width = places?.length ?? rowCount(batch.rows)
  const at = from - batch.firstFrame
  const count = to - from
  const values = new Float64Array(count * width)
  for (let t = 0; t < count; t++)
    for (let r = 0; r < width; r++)
      values[t * width + r] =
        column.values[
          column.offset + (at + t) * column.frameStride + (places?.[r] ?? r) * column.rowStride
        ]!
  return {
    kind: 'samples',
    index: batch.index,
    // The reply's arrays move to the extension, so the rows it names are a copy, never the field's own.
    rows: rows.kind === 'indices' ? { kind: 'indices', values: rows.values.slice() } : rows,
    firstFrame: from,
    coordinates: batch.coordinates.slice(at, at + count),
    columns: {
      [name]: {
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

/** `decoded`, each the frames after the last, as one. */
function joined(decoded: readonly Decoded[], coordinates: Float64Array): Decoded {
  const count = coordinates.length
  return {
    firstFrame: decoded[0]!.firstFrame,
    count,
    coordinates,
    values: decoded[0]!.values.map((head, f) => {
      if (decoded.length === 1) return head
      const values = new Float64Array((head.length / decoded[0]!.count) * count)
      let into = 0
      for (const each of decoded) {
        values.set(each.values[f]!, into)
        into += each.values[f]!.length
      }
      return values
    }),
  }
}

/** Why results that were closed read nothing more: whoever asks of them stops, and says nothing. */
export const closed = () => problem('results-closed', 'These results are closed.')

/** What a reading of a results file is, besides the file: the case revision it is read against,
 *  and the solver file whose run writes it and the times that run covers. */
export interface Reading {
  readonly revision: Revision
  readonly path: string
  readonly solver?: string
  readonly span?: Domain
}

/** A GridKit results file read for a case, in chunks of frames that every process cuts alike: the
 *  header's width sets how many frames each holds. Its CSV is read once, as it is written or
 *  opened, into a store of Studio's own, which every read after reads: whatever becomes of the CSV,
 *  what the views draw is what was read. Only it changes what it says of itself. */
export class ResultsFile {
  #layout: ResultsLayout
  readonly #progress: { -readonly [K in keyof ResultsProgress]: ResultsProgress[K] }
  /** How the file reads, from its header. */
  readonly #decode: Layout = {}
  #times?: Times
  /** The frames read of the chunk not yet whole, in order, and those frames as one. */
  #tail: Decoded[] = []
  #joined?: { readonly count: number; readonly frames: Frames }
  /** The chunks being written to the store, which a read of one waits for. */
  readonly #writing = new Map<number, Promise<void>>()
  /** The fields of chunks being read from the store, by their keys, which a read of one shares. */
  readonly #reading = new Map<number, Promise<Data.SampleBatch>>()
  /** The file's size and time as it was read through. */
  #stamp?: { readonly size: number; readonly mtimeMs: number }
  /** Who reads the file now, each done once its promise settles. */
  readonly #readers = new Map<AbortController, Promise<void>>()
  #retired = false

  constructor(
    readonly kase: Case,
    readonly cache: ResultCache,
    /** Where its frames are kept. */
    readonly store: Store,
    { revision, path, solver, span }: Reading,
  ) {
    this.#layout = {
      revision: { uri: revision.uri, version: revision.version },
      fingerprint: kase.version,
      name: basename(path),
      path,
      outputs: [],
      chunk: 0,
      ...(solver && { solver }),
      ...(span && { span }),
    }
    this.#progress = { frames: 0, domain: [0, 0], domains: {}, growing: false }
  }

  /** The results file `store`, read through, holds: read from the store alone. */
  static async stored(
    kase: Case,
    cache: ResultCache,
    store: Store,
    reading: Reading,
  ): Promise<ResultsFile> {
    const manifest = store.manifest!
    const file = new ResultsFile(kase, cache, store, reading)
    Object.assign(file.#decode, layoutFrom(manifest.header, kase))
    file.#learned(manifest.chunk)
    file.#times!.push(await store.times())
    Object.assign(file.#progress, {
      frames: manifest.frames,
      domain: manifest.domain,
      domains: manifest.domains,
    })
    file.#stamp = { size: manifest.size, mtimeMs: manifest.mtimeMs }
    return file
  }

  /** What the file is: fixed once its header is read. */
  get layout(): ResultsLayout {
    return this.#layout
  }

  /** How far it is read. */
  get progress(): ResultsProgress {
    return this.#progress
  }

  /** What the file holds, once its header is read. */
  get fields(): readonly Field[] {
    return this.#decode.read?.fields ?? []
  }

  /** Whether it is the file at `path`. */
  of(path: string): boolean {
    return fileKey(path) === this.store.key
  }

  /** Whether the file at its path, of the size and time `now` says, is what it read: being read
   *  now, or read through and unchanged since. */
  current(now: { readonly size: number; readonly mtimeMs: number }): boolean {
    return (
      this.#progress.growing ||
      (this.#stamp?.size === now.size && this.#stamp.mtimeMs === now.mtimeMs)
    )
  }

  /** What it keeps alive of its own while nothing holds it: its case, and every frame's time. */
  get bytes(): number {
    return this.kase.bytes + (this.#times?.bytes ?? 0)
  }

  /** Reads the file with `read` until it settles. Retiring the file stops it, and waits for it. */
  async use<R>(signal: AbortSignal, read: (signal: AbortSignal) => Promise<R>): Promise<R> {
    signal.throwIfAborted()
    if (this.#retired) throw closed()
    const reader = new AbortController()
    let done!: () => void
    this.#readers.set(reader, new Promise<void>((resolve) => (done = resolve)))
    try {
      return await read(AbortSignal.any([signal, reader.signal]))
    } finally {
      this.#readers.delete(reader)
      done()
    }
  }

  /** Stops whoever reads the file, waits for them, and lets go of its chunks. The file stays, and
   *  its store is its owner's to keep or let go of. */
  async retire(): Promise<void> {
    this.#retired = true
    const readers = [...this.#readers]
    for (const [reader] of readers) reader.abort(closed())
    await Promise.all(readers.map(([, done]) => done))
    await Promise.allSettled(this.#writing.values())
    this.cache.drop(this)
    this.#tail = []
    this.#joined = undefined
  }

  /** Follows the results file as it is written, reading each segment as it comes, and tells
   *  `progress` after each. Returns once `writer` is done and the file has nothing more, the store
   *  then saying what it holds. Meanwhile it grows; why it stops short, if it does, it says, and
   *  keeps what it read. */
  async ingest(
    signal: AbortSignal,
    writer: () => Writer,
    progress: () => Promise<void> | void,
  ): Promise<void> {
    this.#progress.growing = true
    try {
      for await (const piece of follow(this.#layout.path, signal, writer)) {
        if (piece.kind === 'header') await this.#learn(piece.bytes, signal)
        else if (piece.kind === 'segment') {
          await this.#append(piece.bytes, signal)
          await progress()
        } else this.#stamp = piece.stamp
      }
      await this.#settle()
      const { frames, domain, domains } = this.#progress
      // A file written to as it was read through is read again whole when opened again.
      if (this.#stamp && this.#decode.header)
        await this.store.finish(
          {
            path: this.#layout.path,
            ...this.#stamp,
            fingerprint: this.kase.version,
            header: this.#decode.header,
            frames,
            chunk: this.#layout.chunk,
            domain,
            domains: domains ?? {},
          },
          this.#times?.all() ?? new Float64Array(0),
        )
    } catch (error) {
      if (!signal.aborted) {
        this.#progress.error = message(error)
        await this.#settle().catch(() => {})
      }
      throw error
    } finally {
      this.#progress.growing = false
    }
  }

  /** The first frame time after `at`, or the last before it when `direction` is -1: the first or
   *  last time when there is none. */
  step(at: number, direction: -1 | 1): number {
    const { frames, domain } = this.#progress
    const times = this.#times
    if (!times) return domain[0]
    if (direction > 0) {
      const next = firstWhere(frames, (i) => times.at(i) > at)
      return next === frames ? domain[1] : times.at(next)
    }
    const previous = firstWhere(frames, (i) => times.at(i) >= at) - 1
    return previous < 0 ? domain[0] : times.at(previous)
  }

  /** The case's data with the chunks whose frames reach over `window`: of the fields of type
   *  `from`, as a query of its rows reads, else of every field. */
  async data(window: Domain, signal: AbortSignal, from?: string): Promise<Data> {
    const { chunk } = this.#layout
    const fields = this.fields.flatMap((field, f) =>
      from === undefined || field.index.type === from ? [f] : [],
    )
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
    const { chunk } = this.#layout
    const { frames } = this.#progress
    const f = this.#fieldOf(field)
    if (!chunk || f < 0) return []
    const places = this.#placesOf(f, field)
    if (places?.length === 0) return []
    const { name, rows } = this.fields[f]!
    const named = places ? axisOf(places.map((place) => rows[place]!)) : this.fields[f]!.axis
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
      const { batch, chosen } = await this.#rowsOf(k, f, places, signal)
      const sent = copied(batch, name, from, to, named, chosen ? undefined : places)
      reply.push(sent)
      size += blockByteLength([sent])
    }
    return reply
  }

  /** Copies the file to `path`: it is GridKit's CSV already, as long as it is still the file read. */
  async exportCsv(path: string) {
    if (this.of(path)) throw new Error('Choose a different file from the open results.')
    if (!this.current(await stat(this.#layout.path)))
      throw new Error(
        `${this.#layout.name} was written again after it was read. Open it again to export what it holds now.`,
      )
    await mkdir(dirname(path), { recursive: true })
    await copyFile(this.#layout.path, path)
  }

  /** Where `from`'s `select`ed field is among those the file holds; -1 where it holds none. */
  #fieldOf({ from, select: [name] }: Query.Selection): number {
    return this.fields.findIndex((field) => field.index.type === from && field.name === name)
  }

  /** Where the rows `selection` names sit among those field `f` holds, ascending; undefined when
   *  it names none, and so every one the file holds. */
  #placesOf(f: number, { from, rows }: Query.Selection): Uint32Array | undefined {
    if (!rows) return undefined
    const held = this.fields[f]!.rows
    const wanted = selectRows(this.kase.data.tables[from]!, rows)
    const found: number[] = []
    for (let i = 0; i < rowCount(wanted); i++) {
      const place = seek(held, rowAt(wanted, i))
      if (held[place] === rowAt(wanted, i)) found.push(place)
    }
    return Uint32Array.from(found.sort((a, b) => a - b))
  }

  /** Field `f` of chunk `k`, of the rows at `places` when given: those alone, `chosen`, when only
   *  they are read from the store, else every row the file holds. */
  async #rowsOf(
    k: number,
    f: number,
    places: Uint32Array | undefined,
    signal: AbortSignal,
  ): Promise<{ batch: Data.SampleBatch; chosen: boolean }> {
    const whole = () =>
      this.#chunk(k, signal, [f]).then(([batch]) => ({ batch: batch!, chosen: false }))
    if (!places || this.#tailHolds(k) || this.cache.get(this, this.#keyOf(k, f))) return whole()
    await this.#writing.get(k)
    signal.throwIfAborted()
    const count = this.#countOf(k)
    const values = await this.store.read(k, f, count, places)
    return { batch: this.#stored(k, f, count, values, places), chosen: true }
  }

  /** Reads the file's header alone, which gives the layout every segment is read with. */
  async #learn(header: Uint8Array, signal: AbortSignal) {
    await readResults(
      Readable.from([header]),
      this.kase,
      { signal, publish: () => {} },
      this.#decode,
    )
    this.#learned(chunkFrames(this.fields))
  }

  /** Says what the file holds and how it is cut, `chunk` frames a chunk, once its header says. */
  #learned(chunk: number) {
    if (this.#layout.outputs.length || !this.fields.length) return
    this.#layout = { ...this.#layout, outputs: selectionsOf(this.fields), chunk }
    this.store.shape(
      this.fields.map((field) => field.rows.length),
      chunk,
    )
    this.#times = new Times(chunk)
  }

  /** Read through, the chunk not yet whole is kept as the whole ones are: in the store, and the
   *  cache. */
  async #settle() {
    if (this.#tail.length && !this.#retired)
      await this.#keep(Math.floor(this.#progress.frames / this.#layout.chunk))
  }

  /** How many frames chunk `k` holds now. */
  #countOf(k: number): number {
    const { chunk } = this.#layout
    return Math.min(chunk, this.#progress.frames - k * chunk)
  }

  /** Whether chunk `k` is the one the frames not yet kept fill. */
  #tailHolds(k: number): boolean {
    return this.#tail.length > 0 && k === Math.floor(this.#progress.frames / this.#layout.chunk)
  }

  /** The frames from where they reach over `[a, b]`: from the last at or before `a` up to the first
   *  at or after `b`, as a frame and the frame past the last. */
  #span([a, b]: Domain): [number, number] {
    const { frames } = this.#progress
    const times = this.#times
    if (!frames || !times) return [0, 0]
    const first = Math.max(0, firstWhere(frames, (i) => times.at(i) > a) - 1)
    const last = Math.min(
      frames - 1,
      firstWhere(frames, (i) => times.at(i) >= b),
    )
    return [first, Math.max(first, last) + 1]
  }

  /** How far chunk `k`'s times lie from `at`; while a playhead plays, time behind it counts more. */
  #distance(k: number, { at, travel }: { at: number; travel: number }): number {
    const { chunk } = this.#layout
    const times = this.#times!
    const start = times.at(k * chunk)
    const end = times.at(k * chunk + this.#countOf(k) - 1)
    if (at < start) return (start - at) * (travel < 0 ? BEHIND : 1)
    if (at > end) return (at - end) * (travel > 0 ? BEHIND : 1)
    return 0
  }

  /** The cache's key for field `f` of chunk `k`. Each field of a chunk is kept apart, so a view's
   *  field is read alone, and the fields views read stay as the rest go. */
  #keyOf(k: number, f: number): number {
    return k * this.fields.length + f
  }

  /** Field `f` of chunk `k`, `count` frames of `values` as the store keeps them, row by row: of the
   *  rows at `places` when given, else of every one. */
  #stored(
    k: number,
    f: number,
    count: number,
    values: Float64Array,
    places?: Uint32Array,
  ): Data.SampleBatch {
    const field = this.fields[f]!
    return {
      kind: 'samples',
      index: field.index,
      rows: places ? axisOf(places.map((place) => field.rows[place]!)) : field.axis,
      firstFrame: k * this.#layout.chunk,
      coordinates: this.#times!.of(k * this.#layout.chunk, count),
      columns: {
        [field.name]: {
          kind: 'numeric',
          values,
          offset: 0,
          length: values.length,
          frameStride: 1,
          rowStride: count,
        },
      },
    } as Data.SampleBatch
  }

  /** Chunk `k`'s frames read so far of `fields`, by their place among the file's, one batch each:
   *  the frames not yet kept from memory, the rest from the cache, else the store, into the cache
   *  as a view read them. */
  async #chunk(k: number, signal: AbortSignal, fields: readonly number[]): Promise<Frames> {
    const { chunk } = this.#layout
    if (k * chunk >= this.#progress.frames) return []
    if (this.#tailHolds(k)) {
      const { frames } = this.#progress
      if (this.#joined?.count !== frames)
        this.#joined = {
          count: frames,
          frames: samplesOf(
            this.fields,
            joined(this.#tail, this.#times!.of(k * chunk, frames - k * chunk)),
          ),
        }
      const tail = this.#joined.frames
      return fields.map((f) => tail[f]!)
    }
    await this.#writing.get(k)
    const count = this.#countOf(k)
    return Promise.all(
      fields.map(async (f) => {
        const key = this.#keyOf(k, f)
        const cached = this.cache.get(this, key)?.[0]
        if (cached) return cached
        signal.throwIfAborted()
        // Asked for meanwhile, as the Network and the Monitor do at once, it is read once.
        let read = this.#reading.get(key)
        if (!read) {
          read = this.store
            .read(k, f, count)
            .then((values) => {
              const batch = this.#stored(k, f, count, values)
              this.cache.put(this, key, [batch], true)
              return batch
            })
            .finally(() => this.#reading.delete(key))
          this.#reading.set(key, read)
        }
        return read
      }),
    )
  }

  /** Reads the segment `bytes`: each group of its frames in turn. */
  async #append(bytes: Uint8Array, signal: AbortSignal) {
    await readResults(
      Readable.from([bytes]),
      this.kase,
      { signal, first: this.#progress.frames, publish: (frames) => this.#add(frames) },
      this.#decode,
    )
  }

  /** Takes in `frames`, the next read: their times, the ranges of their values, and the chunk they
   *  fill, which, once whole, is kept. */
  async #add(frames: Decoded) {
    const { count, coordinates, values } = frames
    if (!count) return
    const times = this.#times!
    const progress = this.#progress
    if (coordinates[0]! < (progress.frames ? times.at(progress.frames - 1) : -Infinity))
      throw new Error('Result times must be nondecreasing.')
    times.push(coordinates)
    // Measured once, as frames are read: every view uses these ranges, and scrubbing never
    // rescans history or normalizes one frame.
    const domains = (progress.domains ??= {})
    this.fields.forEach((field, f) => {
      const ranges = (domains[field.index.type] ??= {})
      let [min, max] = ranges[field.name] ?? [Infinity, -Infinity]
      for (const value of values[f]!)
        if (Number.isFinite(value)) {
          if (value < min) min = value
          if (value > max) max = value
        }
      if (min <= max) ranges[field.name] = [min, max]
    })
    progress.frames += count
    progress.domain = [times.at(0), coordinates[count - 1]!]
    this.#tail.push(frames)
    this.#joined = undefined
    const { chunk } = this.#layout
    if (progress.frames % chunk === 0) await this.#keep(progress.frames / chunk - 1)
  }

  /** Chunk `k`, of the frames not yet kept, is whole, or the last once read through: written to
   *  the store, and kept cold in the cache meanwhile, as no view has read it yet. */
  async #keep(k: number): Promise<void> {
    const tail = this.#tail
    this.#tail = []
    this.#joined = undefined
    const count = tail.reduce((sum, each) => sum + each.count, 0)
    const frames = joined(tail, this.#times!.of(k * this.#layout.chunk, count))
    const written = this.store.write(k, count, frames.values)
    this.#writing.set(k, written)
    samplesOf(this.fields, frames).forEach((batch, f) =>
      this.cache.put(this, this.#keyOf(k, f), [batch], false),
    )
    try {
      await written
    } finally {
      this.#writing.delete(k)
    }
  }
}
