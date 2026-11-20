/** Results stay on disk. Requests read bounded windows by recorded time. */
import { type Id, Patch } from 'latkit'

import type { Case } from '../gridkit/case.js'
import { chunks } from '../platform/bytes.js'
import { randomUUID } from '../platform/crypto.js'
import { type FileHandle, mkdir, open, rename, rm } from '../platform/files.js'
import { basename, dirname, join } from '../platform/path.js'
import {
  type ExactSample,
  type ExactSampleRequest,
  type FramePage,
  type FrameRequest,
  PAGE_BYTES,
  type TileRequest,
  type TimeRange,
} from '../shared/data.js'
import { sameField } from '../shared/document.js'
import { message, problem } from '../shared/errors.js'
import {
  type ResultsLayout,
  type ResultsProgress,
  type Revision,
  revisionOf,
} from '../shared/messages.js'
import { longReading } from './csv.js'
import {
  type Decoded,
  type Field,
  type Layout,
  layoutFrom,
  readResults,
  recordedFields,
} from './decode.js'
import { follow, type Writer } from './follow.js'
import { rawRun, type VisualizationRun } from './frames.js'
import { SEGMENT_BYTES } from './limits.js'
import { Pyramid } from './pyramid.js'
import { same, type Stamp, stampAt } from './stamp.js'
import { fileKey, type LevelIndex, lost, type RawIndex, type Store } from './store.js'

export const closed = () => problem('results-closed', 'These results are closed.')
export interface Reading {
  readonly revision: Revision
  readonly path: string
  readonly solver?: string
  readonly span?: TimeRange
}
/** Target bytes of a time-tile span (latkit's advice), and of a level's buffered buckets. */
const SPAN_BYTES = 1 << 20
/** Entries per time-tile span, sized for bucket entries: a multiple of 8, so a bucket one level up
 *  never straddles two spans. */
const spanEntries = (rows: number) =>
  Math.min(1 << 20, Math.max(8, Math.floor(SPAN_BYTES / (16 + 8 * rows) / 8) * 8))
/** The highest level with at least one complete bucket among `frames` frames. */
function levelsOf(frames: number): number {
  let level = 0
  while (level < 21 && frames >= 8 ** (level + 1)) level++
  return level
}
function lowerBound(count: number, predicate: (index: number) => boolean): number {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (predicate(mid)) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** The frames of `run` in `picks[from..to)`, renumbered by pick so a page has no gaps. */
function picked(
  run: VisualizationRun,
  picks: readonly number[],
  from: number,
  to: number,
  rows: number,
): VisualizationRun {
  const at = new Float64Array(to - from)
  const values = new Float32Array((to - from) * rows)
  for (let pick = from; pick < to; pick++) {
    const frame = picks[pick]! - run.first
    at[pick - from] = run.at[frame]!
    values.set(run.values.subarray(frame * rows, (frame + 1) * rows), (pick - from) * rows)
  }
  return { level: 0, first: from, at, values }
}

/** Merges consecutive bucket runs into one run of only the rows at `places`. */
function selected(
  runs: readonly VisualizationRun[],
  places: readonly number[],
  rows: number,
): VisualizationRun {
  const count = runs.length
  const at = new Float64Array(2 * count)
  const values = new Float32Array(2 * count * places.length)
  runs.forEach((run, i) => {
    at.set(run.at, 2 * i)
    places.forEach((place, p) => {
      values[i * places.length + p] = run.values[place]!
      values[(count + i) * places.length + p] = run.values[rows + place]!
    })
  })
  return { level: runs[0]!.level, first: runs[0]!.first, at, values }
}

async function fill(
  file: FileHandle,
  bytes: Uint8Array,
  length: number,
  position: number,
): Promise<number> {
  let read = 0
  while (read < length) {
    const { bytesRead } = await file.read(bytes, read, length - read, position + read)
    if (!bytesRead) break
    read += bytesRead
  }
  return read
}

/** Compares four bytes at a time, so both arrays must start at offset 0 of their buffers. */
function sameBytes(a: Uint8Array, b: Uint8Array, length: number): boolean {
  const words = length >> 2
  const x = new Int32Array(a.buffer, a.byteOffset, words)
  const y = new Int32Array(b.buffer, b.byteOffset, words)
  for (let i = 0; i < words; i++) if (x[i] !== y[i]) return false
  for (let i = words << 2; i < length; i++) if (a[i] !== b[i]) return false
  return true
}

export class ResultsFile {
  #layout: ResultsLayout
  /** `domains` is always present, and empty until the first frame. */
  readonly #progress: { -readonly [K in keyof ResultsProgress]: ResultsProgress[K] } & {
    domains: NonNullable<ResultsProgress['domains']>
  }
  readonly #decode: Layout = {}
  readonly #readers = new Map<AbortController, Promise<void>>()
  #reducers: Pyramid[] = []
  /** Per field and level, reduced buckets not yet written. */
  #pending: Map<number, VisualizationRun[]>[] = []
  #places: ReadonlyMap<Id, number>[] = []
  #allPlaces: (readonly number[])[] = []
  #opened?: Stamp
  #stamp?: Stamp
  #read = 0
  /** Whether the store's frames match exactly the bytes kept, between samples in a long layout. */
  #resumable = true
  #retired = false
  constructor(
    readonly kase: Case,
    readonly store: Store,
    { revision, path, solver, span }: Reading,
  ) {
    this.#layout = {
      revision: revisionOf(revision),
      fingerprint: kase.version,
      name: basename(path),
      path,
      outputs: [],
      ...(solver && { solver }),
      ...(span && { span }),
    }
    this.#progress = { frames: 0, domain: [0, 0], domains: {}, growing: false }
  }
  /** Throws `lost` when the store is empty or damaged. */
  static async stored(kase: Case, store: Store, reading: Reading): Promise<ResultsFile> {
    const resume = await store.restore()
    const manifest = store.manifest
    const file = new ResultsFile(kase, store, reading)
    if (!resume || !manifest) throw lost(`Studio kept nothing of ${file.#layout.name}.`)
    try {
      Object.assign(file.#decode, layoutFrom(resume.header, kase))
      if (manifest.long) file.#decode.long = longReading(manifest.long, resume.header.slice(1))
      file.#learned()
      file.#reducers.forEach((reducer, i) => reducer.restore(resume.reducers[i]!))
    } catch (error) {
      throw lost(`GridKit Studio's copy of ${file.#layout.name} is damaged.`, error)
    }
    Object.assign(file.#progress, {
      frames: manifest.frames,
      domain: manifest.domain,
      domains: manifest.domains,
    })
    file.#opened = manifest.stamp
    if (manifest.complete) file.#stamp = manifest.stamp
    file.#read = manifest.read
    return file
  }
  get layout(): ResultsLayout {
    return this.#layout
  }
  get progress(): ResultsProgress {
    return this.#progress
  }
  get fields(): readonly Field[] {
    return this.#decode.read?.fields ?? []
  }
  get bytes(): number {
    return this.store.bytes
  }
  of(path: string): boolean {
    return fileKey(path) === this.store.key
  }
  current(now: Stamp | undefined): boolean {
    return this.#progress.growing ? now?.file === this.#opened?.file : same(now, this.#stamp)
  }
  async use<R>(
    signal: AbortSignal | undefined,
    read: (signal: AbortSignal) => Promise<R>,
  ): Promise<R> {
    signal?.throwIfAborted()
    if (this.#retired) throw closed()
    const controller = new AbortController()
    let done!: () => void
    this.#readers.set(controller, new Promise<void>((resolve) => (done = resolve)))
    try {
      return await read(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
    } finally {
      this.#readers.delete(controller)
      done()
    }
  }
  /** After a read that stopped early, accepts the file's current stamp as read. */
  async settle(): Promise<void> {
    if (this.#stamp || this.#progress.growing || !this.#opened) return
    const now = await stampAt(this.#layout.path).catch(() => undefined)
    if (now?.file === this.#opened.file) this.#stamp = now
  }
  async retire(): Promise<void> {
    this.#retired = true
    const readers = [...this.#readers]
    for (const [controller] of readers) controller.abort(closed())
    await Promise.all(readers.map(([, done]) => done))
    this.#pending = []
  }
  /** Throws `lost` unless the file still starts with the bytes the store kept. */
  async #verifyPrefix(signal: AbortSignal): Promise<void> {
    const changed = () =>
      lost(`${this.#layout.name} changed in what Studio kept of it, so it is read again.`)
    const original = await open(this.#layout.path, 'r')
    let cached: FileHandle | undefined
    try {
      cached = await open(join(this.store.folder, 'source.csv'), 'r')
      const a = new Uint8Array(SEGMENT_BYTES)
      const b = new Uint8Array(SEGMENT_BYTES)
      for (let at = 0; at < this.#read;) {
        signal.throwIfAborted()
        const length = Math.min(a.length, this.#read - at)
        const [x, y] = await Promise.all([
          fill(original, a, length, at),
          fill(cached, b, length, at),
        ])
        if (x !== length || y !== length || !sameBytes(a, b, length)) throw changed()
        at += length
      }
    } finally {
      await Promise.allSettled([original.close(), cached?.close()])
    }
  }
  /** Reads the file from where the store left off until `writer` is done, and checkpoints once when
   *  the read ends. If the window closes first, the store has no manifest and is read again. */
  async ingest(
    signal: AbortSignal,
    writer: () => Writer,
    progress: () => Promise<void> | void,
    last?: Stamp,
  ): Promise<void> {
    this.#progress.growing = true
    try {
      if (this.#read) await this.#verifyPrefix(signal)
      for await (const piece of follow(
        this.#layout.path,
        signal,
        writer,
        last,
        this.#read ? { offset: this.#read, stamp: this.#opened! } : undefined,
      )) {
        if (piece.kind === 'header') {
          this.#opened = piece.stamp
          await readResults(
            chunks([piece.bytes]),
            this.kase,
            { signal, publish: () => {} },
            this.#decode,
          )
          // A long layout learns its fields from its first sample instead.
          if (this.#decode.read) this.#learned()
          await this.store.writeCsv(piece.bytes, this.#read)
          this.#read += piece.bytes.length
        } else if (piece.kind === 'segment') {
          await this.#take(signal, piece.bytes)
          await progress()
        } else {
          // A long layout's pending sample is complete once the writer is done.
          if (this.#decode.long && writer() === 'done') await this.#take(signal)
          this.#stamp = piece.stamp
        }
      }
      await this.#checkpoint()
    } catch (error) {
      if (!signal.aborted) this.#progress.error = message(error)
      // Checkpoint what was kept anyway.
      await this.#checkpoint().catch(() => {})
      throw error
    } finally {
      this.#progress.growing = false
    }
  }
  /** Stores a segment of whole rows, or with no `bytes`, a long layout's final sample. Frames are
   *  decoded before anything is stored, so a bad segment leaves the store unchanged. */
  async #take(signal: AbortSignal, bytes?: Uint8Array): Promise<void> {
    const decoded: Decoded[] = []
    await readResults(
      chunks(bytes ? [bytes] : []),
      this.kase,
      {
        signal,
        first: this.#progress.frames,
        final: !bytes,
        publish: (frames) => void decoded.push(frames),
      },
      this.#decode,
    )
    this.#resumable = false
    for (const frames of decoded) await this.#add(frames)
    if (bytes) {
      await this.store.writeCsv(bytes, this.#read)
      this.#read += bytes.length
    }
    const long = this.#decode.long
    this.#resumable = !long || (long.sample < 0 && !long.pending)
  }
  #learned(): void {
    this.#layout = { ...this.#layout, outputs: recordedFields(this.fields) }
    this.store.shape(this.fields.map((field) => field.ids.length))
    this.#places = this.fields.map((field) => new Map(field.ids.map((id, place) => [id, place])))
    this.#allPlaces = this.fields.map((field) => Array.from(field.ids, (_, place) => place))
    this.#pending = this.fields.map(() => new Map())
    this.#reducers = this.fields.map(
      (field, f) =>
        new Pyramid(field.ids.length, (run) => {
          const queued = this.#pending[f]!.get(run.level) ?? []
          queued.push(run)
          this.#pending[f]!.set(run.level, queued)
        }),
    )
  }
  async #add(frames: Decoded): Promise<void> {
    if (!frames.count) return
    if (!this.#reducers.length) this.#learned()
    const progress = this.#progress
    if (
      frames.firstFrame !== progress.frames ||
      frames.coordinates[0]! < (progress.frames ? progress.domain[1] : -Infinity)
    )
      throw new Error('Result times must be nondecreasing.')
    await this.store.writeRaw(frames.firstFrame, frames.coordinates, frames.values)
    this.fields.forEach((field, f) => {
      const ranges = (progress.domains[field.table] ??= {})
      let [min, max] = ranges[field.field] ?? [Infinity, -Infinity]
      for (const value of frames.values[f]!)
        if (Number.isFinite(value)) {
          min = Math.min(min, value)
          max = Math.max(max, value)
        }
      if (min <= max) ranges[field.field] = [min, max]
      this.#reducers[f]!.push(frames.firstFrame, frames.coordinates, frames.values[f]!)
    })
    progress.domain = [
      progress.frames ? progress.domain[0] : frames.coordinates[0]!,
      frames.coordinates.at(-1)!,
    ]
    progress.frames += frames.count
    await this.#flushLevels(false)
  }
  /** Writes a level's pending buckets once they fill a span, or all with `whole`, so level blocks
   *  stay span-sized however the file arrived. */
  async #flushLevels(whole: boolean): Promise<void> {
    for (let f = 0; f < this.#pending.length; f++) {
      const weight = 16 + 8 * this.fields[f]!.ids.length
      for (const [level, runs] of this.#pending[f]!)
        if (whole || runs.length * weight >= SPAN_BYTES) {
          await this.store.writeLevel(f, level, runs)
          this.#pending[f]!.delete(level)
        }
    }
  }
  /** Writes the manifest unless current: complete, or partial when a later read can resume. */
  async #checkpoint(): Promise<void> {
    if (!this.#decode.header || !this.#opened) return
    await this.#flushLevels(true)
    const complete = !!this.#stamp
    if (!(complete || this.#resumable)) return
    const manifest = this.store.manifest
    if (manifest?.read === this.#read && manifest.complete === complete) return
    const long = this.#decode.long
    await this.store.checkpoint({
      path: this.#layout.path,
      stamp: this.#stamp ?? this.#opened,
      read: this.#read,
      fingerprint: this.kase.version,
      header: this.#decode.header,
      ...(long && { long: long.columns }),
      frames: this.#progress.frames,
      domain: this.#progress.domain,
      domains: this.#progress.domains,
      complete,
      reducers: this.#reducers.map((reducer) => reducer.snapshot()),
    })
  }
  async #bound(at: number, strict: boolean, frames = this.#progress.frames): Promise<number> {
    const blocks = this.store.raw
    const index = lowerBound(blocks.length, (i) =>
      strict ? blocks[i]!.end > at : blocks[i]!.end >= at,
    )
    const block = blocks[index]
    if (!block || block.first >= frames) return frames
    const times = await this.store.times(block, 0, Math.min(block.count, frames - block.first))
    return (
      block.first + lowerBound(times.length, (i) => (strict ? times[i]! > at : times[i]! >= at))
    )
  }
  /** The frames a view sampling `range` every `step` seconds shows: the last frame at or before
   *  each sample time. Cost scales with frames shown, not frames stored. */
  async #picks(range: TimeRange, step: number, frames: number): Promise<number[]> {
    const blocks = this.store.raw
    let cached: { block: RawIndex; times: Float64Array } | undefined
    const timesOf = async (block: RawIndex) => {
      if (cached?.block !== block)
        cached = {
          block,
          times: await this.store.times(block, 0, Math.min(block.count, frames - block.first)),
        }
      return cached.times
    }
    /** The last frame at or before `at`, or -1. */
    const before = async (at: number) => {
      const block = blocks[lowerBound(blocks.length, (i) => blocks[i]!.end > at)]
      if (!block || block.first >= frames) return frames - 1
      const times = await timesOf(block)
      return block.first + lowerBound(times.length, (i) => times[i]! > at) - 1
    }
    const picks: number[] = []
    const last = Math.floor((range[1] - range[0]) / step)
    for (let shown = 0; shown <= last;) {
      const frame = await before(range[0] + shown * step)
      if (frame >= 0 && frame !== picks.at(-1)) picks.push(frame)
      if (frame + 1 >= frames) break
      // Skip to the first sample time at or after the next frame's time.
      const block = this.#rawAt(frame + 1)
      const next = (await timesOf(block))[frame + 1 - block.first]!
      shown = Math.max(shown + 1, Math.floor((next - range[0]) / step))
    }
    return picks
  }
  #rawAt(frame: number): RawIndex {
    const blocks = this.store.raw
    const index = lowerBound(blocks.length, (i) => blocks[i]!.first + blocks[i]!.count > frame)
    const block = blocks[index]
    if (!block || block.first > frame)
      throw lost(`What Studio kept of ${this.#layout.name} lacks a block of its frames.`)
    return block
  }
  async #time(frame: number): Promise<number> {
    const block = this.#rawAt(frame)
    return (await this.store.times(block, frame - block.first, 1))[0]!
  }
  async step(at: number, direction: -1 | 1): Promise<number> {
    if (!Number.isFinite(at)) throw new Error('Invalid sample time.')
    if (!this.#progress.frames) return 0
    const frame =
      direction > 0
        ? Math.min(this.#progress.frames - 1, await this.#bound(at, true))
        : Math.max(0, (await this.#bound(at, false)) - 1)
    return this.#time(frame)
  }
  async sample(request: ExactSampleRequest, signal: AbortSignal): Promise<ExactSample> {
    if (!Number.isFinite(request.at)) throw new Error('Invalid sample time.')
    const field = this.fields.findIndex((item) => sameField(item, request))
    const place = this.#places[field]?.get(request.id)
    if (place === undefined || !this.#progress.frames) return { at: request.at, value: null }
    const frame = (await this.#bound(request.at, true)) - 1
    signal.throwIfAborted()
    if (frame < 0) return { at: request.at, value: null }
    const block = this.#rawAt(frame)
    const raw = await this.store.readRaw(block, field, [place], frame - block.first, 1)
    signal.throwIfAborted()
    return { at: raw.at[0]!, value: Number.isFinite(raw.values[0]) ? raw.values[0]! : null }
  }
  #levelAt(field: number, level: number, bucket: number): LevelIndex | undefined {
    const blocks = this.store.levels.get(`${field}:${level}`) ?? []
    const index = lowerBound(blocks.length, (i) => blocks[i]!.first + blocks[i]!.count > bucket)
    const block = blocks[index]
    return block && block.first <= bucket ? block : undefined
  }
  #rows(
    table: string,
    field: string,
    id?: Id,
  ): { field: number; ids: readonly Id[]; places: readonly number[] } {
    const index = this.fields.findIndex((item) => item.table === table && item.field === field)
    if (index < 0) throw new Error('The requested field was not recorded.')
    if (id === undefined)
      return { field: index, ids: this.fields[index]!.ids, places: this.#allPlaces[index]! }
    const place = this.#places[index]!.get(id)
    if (place === undefined) throw new Error('The requested identity was not recorded.')
    return { field: index, ids: [id], places: [place] }
  }
  /** A page of `request.field` from the frame at or before `range[0]` to the first after
   *  `range[1]`, or with a `step`, only the frames a view shows. Always has at least one frame. */
  async frames(request: FrameRequest, signal: AbortSignal): Promise<FramePage> {
    const { table, field, range, step } = request
    if (
      !Number.isFinite(range[0]) ||
      !Number.isFinite(range[1]) ||
      range[1] < range[0] ||
      !Number.isFinite(step) ||
      step < 0
    )
      throw new Error('Invalid result window.')
    const rows = this.#rows(table, field)
    const source = `frames:${basename(this.store.folder)}:${table}:${field}`
    const patch = new Patch(source).axis('time', 's').replace(table, rows.ids)
    const frames = this.#progress.frames
    signal.throwIfAborted()
    const first = frames ? Math.max(0, (await this.#bound(range[0], true, frames)) - 1) : 0
    const stop = frames ? Math.min(frames, (await this.#bound(range[1], true, frames)) + 1) : 0
    const picks = frames && step > 0 ? await this.#picks(range, step, frames) : undefined
    // Encoded size: a time and one value per row for each entry, plus a fixed cost per run.
    const entry = 8 + 4 * rows.places.length
    const empty = new Patch(source).byteLength
    const lone = { level: 0, first: 0, at: new Float64Array(1), values: new Float32Array(1) }
    const run = new Patch(source).frames(table, field, lone).byteLength - empty - 12
    let at = first
    let next = 0
    for (let sent = false; ; sent = true) {
      signal.throwIfAborted()
      const from = picks ? picks[next] : at
      if (from === undefined || from >= stop) break
      // Fill the remaining room, but always send at least one frame.
      const room = Math.floor((PAGE_BYTES - patch.byteLength - run) / entry)
      if (sent && room < 1) break
      const most = Math.max(1, room)
      const block = this.#rawAt(from)
      const end = Math.min(stop, block.first + block.count)
      if (picks) {
        let to = next + 1
        while (to < picks.length && picks[to]! < end && to - next < most) to++
        const read = await this.store.readRaw(
          block,
          rows.field,
          rows.places,
          from - block.first,
          picks[to - 1]! - from + 1,
        )
        patch.frames(table, field, picked(rawRun(read), picks, next, to, rows.places.length))
        next = to
      } else {
        const count = Math.min(end - from, most)
        const read = await this.store.readRaw(
          block,
          rows.field,
          rows.places,
          from - block.first,
          count,
        )
        patch.frames(table, field, rawRun(read))
        at += count
      }
    }
    return { source, table, field, bytes: patch.toBytes() }
  }
  /** One file of `request.field`'s time tiles for latkit's Tiles. A level's last span ends with the
   *  bucket still filling, which the next refresh fetches again. */
  async tile(request: TileRequest, signal: AbortSignal): Promise<Uint8Array> {
    const { table, file } = request
    const rows = this.#rows(table, request.field, request.id)
    const chunk = spanEntries(rows.ids.length)
    const frames = this.#progress.frames
    if (file === 'frames.json')
      return new TextEncoder().encode(
        JSON.stringify({
          data: 'base.latk',
          chunk,
          url: '{level}/{index}.latk',
          frames: [{ table, field: request.field, levels: levelsOf(frames), frames: [0, frames] }],
        }),
      )
    if (file === 'base.latk')
      return new Patch()
        .axis('time', 's')
        .replace(table, rows.ids, { series: Float32Array.from(rows.ids, (_, place) => place) })
        .toBytes()
    const { level, index } = file
    if (
      !Number.isSafeInteger(level) ||
      level < 0 ||
      level > 21 ||
      !Number.isSafeInteger(index) ||
      index < 0
    )
      throw new Error('Invalid time tile.')
    const patch = new Patch()
    for (const run of await this.#entries(rows, level, index * chunk, chunk, frames, signal))
      patch.frames(table, request.field, run)
    return patch.toBytes()
  }
  /** Raw frames at level 0, otherwise stored, then pending, then partial buckets. */
  async #entries(
    { field, places }: { field: number; places: readonly number[] },
    level: number,
    first: number,
    count: number,
    frames: number,
    signal: AbortSignal,
  ): Promise<VisualizationRun[]> {
    const runs: VisualizationRun[] = []
    if (level === 0) {
      for (let at = first, stop = Math.min(frames, first + count); at < stop;) {
        signal.throwIfAborted()
        const block = this.#rawAt(at)
        const taken = Math.min(stop, block.first + block.count) - at
        runs.push(rawRun(await this.store.readRaw(block, field, places, at - block.first, taken)))
        at += taken
      }
      return runs
    }
    const rows = this.fields[field]!.ids.length
    const whole = Math.floor(frames / 8 ** level)
    const stop = Math.min(whole, first + count)
    const waiting = this.#pending[field]?.get(level) ?? []
    for (let at = first; at < stop;) {
      signal.throwIfAborted()
      const block = this.#levelAt(field, level, at)
      if (block) {
        const taken = Math.min(stop, block.first + block.count) - at
        runs.push(await this.store.readLevel(block, places, at - block.first, taken))
        at += taken
        continue
      }
      const from = waiting.length ? at - waiting[0]!.first : -1
      if (from < 0 || from >= waiting.length)
        throw lost(`What Studio kept of ${this.#layout.name} lacks a block of its buckets.`)
      const taken = Math.min(stop - at, waiting.length - from)
      runs.push(selected(waiting.slice(from, from + taken), places, rows))
      at += taken
    }
    const tail = this.#reducers[field]?.tail(level)
    if (tail && tail.first >= first && tail.first < first + count && tail.first === whole)
      runs.push(selected([tail], places, rows))
    return runs
  }
  async exportCsv(path: string): Promise<void> {
    if (this.of(path)) throw new Error('Choose a different file from the open results.')
    if (!this.#read) throw new Error('No results have been read yet.')
    const size = this.#read
    const source = await open(join(this.store.folder, 'source.csv'), 'r')
    const draft = `${path}.${randomUUID().slice(0, 8)}.part`
    try {
      await mkdir(dirname(path), { recursive: true })
      const target = await open(draft, 'w')
      try {
        const bytes = new Uint8Array(1 << 20)
        for (let at = 0; at < size;) {
          const { bytesRead } = await source.read(bytes, 0, Math.min(bytes.length, size - at), at)
          if (!bytesRead) throw new Error('The stored results are truncated.')
          for (let written = 0; written < bytesRead;) {
            const next = await target.write(bytes, written, bytesRead - written, at + written)
            if (!next.bytesWritten) throw new Error('Export write made no progress.')
            written += next.bytesWritten
          }
          at += bytesRead
        }
        await target.sync()
      } finally {
        await target.close()
      }
      await rename(draft, path)
    } finally {
      await rm(draft, { force: true })
      await source.close()
    }
  }
}
