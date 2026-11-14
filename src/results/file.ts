import { type Id, Patch } from 'latkit'

import type { Case } from '../gridkit/case.js'
import { chunks, equal } from '../platform/bytes.js'
/** Scientific results stay on disk; requests read bounded windows by actual timestamps. */
import { createHash, randomUUID } from '../platform/crypto.js'
import { mkdir, open, rename, rm } from '../platform/files.js'
import { basename, dirname, join } from '../platform/path.js'
import {
  ENTRY_BYTES,
  type ExactSample,
  type ExactSampleRequest,
  type FramePage,
  type FrameRequest,
  PAGE_BYTES,
  PAYLOAD_BYTES,
  type TileRequest,
  type TimeRange,
} from '../shared/data.js'
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
import { Pyramid } from './pyramid.js'
import { same, type Stamp, stampAt } from './stamp.js'
import { fileKey, type LevelIndex, type RawIndex, type Store } from './store.js'

export const closed = () => problem('results-closed', 'These results are closed.')
const lost = (name: string, cause: unknown) =>
  problem('results-lost', `What Studio kept of ${name} could not be read.`, { cause })
export interface Reading {
  readonly revision: Revision
  readonly path: string
  readonly solver?: string
  readonly span?: TimeRange
}
interface FramePlan {
  key: string
  source: string
  field: number
  ids: readonly Id[]
  places: readonly number[]
  /** The stored frames the window reads, from `first` to before `stop`, of the `frames` read. */
  first: number
  stop: number
  frames: number
  /** The stored frames the window sends, in order, where it steps past others. */
  picks?: Uint32Array
}
interface Cursor {
  key: string
  frames: number
  /** The frames of the plan's sent so far. */
  offset: number
}
/** The bytes a span of time tiles aims for, as latkit advises. */
const SPAN_BYTES = 1 << 20
/** The entries a span of a field's `rows` rows holds, as a manifest names them: a multiple of 8, from
 *  8 to 2^20, so a bucket one level up never straddles two spans. An entry of a bucket weighs most:
 *  its first and last times, and each row's least and greatest value. */
const spanEntries = (rows: number) =>
  Math.min(1 << 20, Math.max(8, Math.floor(SPAN_BYTES / (16 + 8 * rows) / 8) * 8))
/** The highest level with a whole bucket among `frames` frames: latkit's levels of a field. */
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

/** The frames of `run`, read whole from the store, that `picks` names: renumbered by their place
 *  among the picks, so a window's frames run on without gaps. */
function picked(run: VisualizationRun, picks: Uint32Array, rows: number): VisualizationRun {
  const from = lowerBound(picks.length, (i) => picks[i]! >= run.first)
  const to = lowerBound(picks.length, (i) => picks[i]! >= run.first + run.at.length)
  const at = new Float64Array(to - from)
  const values = new Float32Array((to - from) * rows)
  for (let pick = from; pick < to; pick++) {
    const frame = picks[pick]! - run.first
    at[pick - from] = run.at[frame]!
    values.set(run.values.subarray(frame * rows, (frame + 1) * rows), (pick - from) * rows)
  }
  return { level: 0, first: from, at, values }
}

/** `run`, one bucket of every row of a field of `rows` rows, of the rows `places` names alone. */
function selected(
  run: VisualizationRun,
  places: readonly number[],
  rows: number,
): VisualizationRun {
  const values = new Float32Array(places.length * 2)
  places.forEach((place, i) => {
    values[i] = run.values[place]!
    values[places.length + i] = run.values[rows + place]!
  })
  return { ...run, values }
}

export class ResultsFile {
  #layout: ResultsLayout
  /** How far it is read: the ranges of its values always there, none while it holds no frame. */
  readonly #progress: { -readonly [K in keyof ResultsProgress]: ResultsProgress[K] } & {
    domains: NonNullable<ResultsProgress['domains']>
  }
  readonly #decode: Layout = {}
  readonly #readers = new Map<AbortController, Promise<void>>()
  readonly #plans = new Map<string, FramePlan>()
  #reducers: Pyramid[] = []
  /** Each field's buckets reduced and not yet written, by level. */
  #pending: Map<number, VisualizationRun[]>[] = []
  #opened?: Stamp
  #stamp?: Stamp
  #read = 0
  /** Whether a later read can take the file up where the store stands: it holds the frames of
   *  exactly the bytes kept of the file, which end, in a long layout, between two samples. */
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
  static async stored(kase: Case, store: Store, reading: Reading): Promise<ResultsFile> {
    await store.restore()
    const manifest = store.manifest!
    const file = new ResultsFile(kase, store, reading)
    Object.assign(file.#decode, layoutFrom(manifest.header, kase))
    if (manifest.long) file.#decode.long = longReading(manifest.long, manifest.header.slice(1))
    file.#learned()
    file.#reducers.forEach((reducer, i) => reducer.restore(manifest.reducers[i]!))
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
  idle(): void {
    this.#plans.clear()
  }
  get bytes(): number {
    return this.kase.bytes + this.store.bytes
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
  async settle(): Promise<void> {
    if (this.#stamp || this.#progress.growing || !this.#opened) return
    const now = await stampAt(this.#layout.path)
    if (now?.file === this.#opened.file) this.#stamp = now
  }
  async retire(): Promise<void> {
    this.#retired = true
    const readers = [...this.#readers]
    for (const [controller] of readers) controller.abort(closed())
    await Promise.all(readers.map(([, done]) => done))
    this.idle()
    this.#pending = []
  }
  async #verifyPrefix(signal: AbortSignal): Promise<void> {
    const original = await open(this.#layout.path, 'r')
    const cached = await open(join(this.store.folder, 'source.csv'), 'r')
    try {
      const a = new Uint8Array(64 << 10)
      const b = new Uint8Array(64 << 10)
      for (let at = 0; at < this.#read;) {
        signal.throwIfAborted()
        const length = Math.min(a.length, this.#read - at)
        const [x, y] = await Promise.all([
          original.read(a, 0, length, at),
          cached.read(b, 0, length, at),
        ])
        if (
          x.bytesRead !== length ||
          y.bytesRead !== length ||
          !equal(a.subarray(0, length), b.subarray(0, length))
        )
          throw lost(this.#layout.name, new Error('The file changed before what was kept of it.'))
        at += length
      }
    } finally {
      await Promise.allSettled([original.close(), cached.close()])
    }
  }
  /** Reads the file on from what the store keeps of it, until `writer` is done and it holds no
   *  more, telling `progress` of each segment kept. What the store then holds is written down
   *  once, as the read ends, through or short, for a later read to take up: a window that goes
   *  before then leaves a store that says nothing, and the file is read again. */
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
          // A long layout learns what it holds from its first sample, as its frames arrive.
          if (this.#decode.read) this.#learned()
          await this.store.writeCsv(piece.bytes, this.#read)
          this.#read += piece.bytes.length
        } else if (piece.kind === 'segment') {
          await this.#take(signal, piece.bytes)
          await progress()
        } else {
          // A long layout's only sample ends with the file its writer finished.
          if (this.#decode.long && writer() === 'done') await this.#take(signal)
          this.#stamp = piece.stamp
        }
      }
      await this.#checkpoint()
    } catch (error) {
      if (!signal.aborted) this.#progress.error = message(error)
      // What it kept before it stopped is written down all the same; a store that cannot say
      // what it holds is let go of, and its file read again.
      await this.#checkpoint().catch(() => {})
      throw error
    } finally {
      this.#progress.growing = false
    }
  }
  /** Takes a segment of the file, `bytes` of whole rows past those kept, or, with none, the sample
   *  a long layout ends with. Its frames are decoded, then kept, then its bytes: a segment that
   *  does not read leaves the store as it was, holding the frames of exactly the bytes kept. */
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
    this.#pending = this.fields.map(() => new Map())
    this.#reducers = this.fields.map(
      (field, f) =>
        new Pyramid(field.ids.length, (run) => {
          const held = this.#pending[f]!.get(run.level) ?? []
          held.push(run)
          this.#pending[f]!.set(run.level, held)
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
    // Emitted buckets are written in blocks once per decode batch, never once per bucket.
    await this.#flushLevels()
  }
  async #flushLevels(): Promise<void> {
    for (let f = 0; f < this.#pending.length; f++)
      for (const [level, runs] of this.#pending[f]!) {
        await this.store.writeLevel(f, level, runs)
      }
    for (const levels of this.#pending) levels.clear()
  }
  /** Writes down what the store holds of the file, unless it says so already: all of it, once the
   *  file is read through, or as far as a read that stopped short kept it, where a later one can
   *  read on from. */
  async #checkpoint(): Promise<void> {
    const complete = !!this.#stamp
    if (!this.#decode.header || !this.#opened || !(complete || this.#resumable)) return
    const said = this.store.manifest
    if (said?.read === this.#read && said.complete === complete) return
    const long = this.#decode.long
    await this.#flushLevels()
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
    const times = await this.#stored(
      this.store.times(block, 0, Math.min(block.count, frames - block.first)),
    )
    return (
      block.first + lowerBound(times.length, (i) => (strict ? times[i]! > at : times[i]! >= at))
    )
  }
  /** The stored frames from `first` to before `stop` a view shows, stepping `step` seconds through
   *  `range`: of each time from `range[0]`, the last frame at or before it, each frame once. */
  async #picks(first: number, stop: number, range: TimeRange, step: number): Promise<Uint32Array> {
    const times = new Float64Array(stop - first)
    for (let frame = first; frame < stop;) {
      const block = this.#rawAt(frame)
      const count = Math.min(stop, block.first + block.count) - frame
      times.set(
        await this.#stored(this.store.times(block, frame - block.first, count)),
        frame - first,
      )
      frame += count
    }
    const picks: number[] = []
    const last = Math.floor((range[1] - range[0]) / step)
    for (let at = 0; at < times.length; at++) {
      // The first time shown at or after this frame, which shows it unless a later frame comes first.
      const shown = Math.max(0, Math.ceil((times[at]! - range[0]) / step - 1e-9))
      if (shown > last) break
      const next = times[at + 1]
      if (next === undefined || range[0] + shown * step < next) picks.push(first + at)
    }
    return Uint32Array.from(picks)
  }
  #rawAt(frame: number): RawIndex {
    const blocks = this.store.raw
    const index = lowerBound(blocks.length, (i) => blocks[i]!.first + blocks[i]!.count > frame)
    const block = blocks[index]
    if (!block || block.first > frame)
      throw lost(this.#layout.name, new Error('Missing raw frame block.'))
    return block
  }
  async #stored<T>(task: Promise<T>): Promise<T> {
    try {
      return await task
    } catch (error) {
      throw lost(this.#layout.name, error)
    }
  }
  async #time(frame: number): Promise<number> {
    const block = this.#rawAt(frame)
    return (await this.#stored(this.store.times(block, frame - block.first, 1)))[0]!
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
    const field = this.fields.findIndex(
      (item) => item.table === request.table && item.field === request.field,
    )
    const row = this.fields[field]?.ids.indexOf(request.id) ?? -1
    if (row < 0 || !this.#progress.frames) return { at: request.at, value: null }
    const frame = (await this.#bound(request.at, true)) - 1
    signal.throwIfAborted()
    if (frame < 0) return { at: request.at, value: null }
    const block = this.#rawAt(frame)
    const raw = await this.#stored(this.store.readRaw(block, field, [row], frame - block.first, 1))
    signal.throwIfAborted()
    return { at: raw.at[0]!, value: Number.isFinite(raw.values[0]) ? raw.values[0]! : null }
  }
  #levelAt(field: number, level: number, bucket: number): LevelIndex | undefined {
    const blocks = this.store.levels.get(`${field}:${level}`) ?? []
    const index = lowerBound(blocks.length, (i) => blocks[i]!.first + blocks[i]!.count > bucket)
    const block = blocks[index]
    return block && block.first <= bucket ? block : undefined
  }
  /** The recorded field `table`'s `field`, and the places among its rows of `ids`, every row's
   *  without them. */
  #rows(
    table: string,
    field: string,
    ids?: readonly Id[],
  ): { field: number; ids: readonly Id[]; places: number[] } {
    const index = this.fields.findIndex((item) => item.table === table && item.field === field)
    if (index < 0) throw new Error('The requested field was not recorded.')
    const held = this.fields[index]!.ids
    const asked = ids ? [...new Set(ids)] : [...held]
    const positions = new Map(held.map((id, place) => [id, place]))
    const places = asked.map((id) => {
      const row = positions.get(id)
      if (row === undefined) throw new Error('The requested identity was not recorded.')
      return row
    })
    if (!places.length) throw new Error('Choose at least one recorded row.')
    return { field: index, ids: asked, places }
  }
  async #plan(request: FrameRequest, frames: number, signal: AbortSignal): Promise<FramePlan> {
    if (
      !Number.isFinite(request.range[0]) ||
      !Number.isFinite(request.range[1]) ||
      request.range[1] < request.range[0] ||
      !Number.isSafeInteger(request.bytes) ||
      request.bytes < 1024 ||
      request.bytes > PAYLOAD_BYTES ||
      !Number.isFinite(request.step) ||
      request.step < 0 ||
      frames > this.#progress.frames ||
      frames < 0
    )
      throw new Error('Invalid result window.')
    const { field, ids, places } = this.#rows(request.table, request.field, request.ids)
    const base = JSON.stringify([this.store.folder, request.table, request.field, ids])
    const source = 'sample:' + createHash('sha256').update(base).digest('hex').slice(0, 20)
    const key = createHash('sha256')
      .update(JSON.stringify([base, frames, request.range, request.bytes, request.step]))
      .digest('hex')
    const kept = this.#plans.get(key)
    if (kept) return kept
    const first = frames ? Math.max(0, (await this.#bound(request.range[0], true, frames)) - 1) : 0
    const stop = frames
      ? Math.min(frames, (await this.#bound(request.range[1], true, frames)) + 1)
      : 0
    signal.throwIfAborted()
    // The window reads the frames it shows.
    const picks =
      request.step > 0 ? await this.#picks(first, stop, request.range, request.step) : undefined
    signal.throwIfAborted()
    const entries = picks?.length ?? stop - first
    if (entries * (8 + places.length * 4) + ids.length * 16 > request.bytes)
      throw problem(
        'limit',
        'This window exceeds the visualization budget. Choose fewer rows or a narrower time range.',
      )
    const plan: FramePlan = {
      key,
      source,
      field,
      ids,
      places,
      first,
      stop,
      frames,
      ...(picks && { picks }),
    }
    this.#plans.set(key, plan)
    while (this.#plans.size > 16) this.#plans.delete(this.#plans.keys().next().value!)
    return plan
  }
  async frames(request: FrameRequest & { next?: string }, signal: AbortSignal): Promise<FramePage> {
    let cursor: Cursor | undefined
    if (request.next) {
      if (request.next.length > 1024) throw new Error('Invalid frame cursor.')
      cursor = JSON.parse(request.next) as Cursor
      if (![cursor.frames, cursor.offset].every((n) => Number.isSafeInteger(n) && n >= 0))
        throw new Error('Invalid frame cursor.')
    }
    const plan = await this.#plan(request, cursor?.frames ?? this.#progress.frames, signal)
    if (cursor && cursor.key !== plan.key) throw new Error('The result window changed.')
    let offset = cursor?.offset ?? 0
    if (cursor && plan.first + offset >= plan.stop)
      throw new Error('Frame cursor exceeds its window.')
    // The page is written once: each run it takes is measured alone, then added.
    const patch = cursor
      ? new Patch(plan.source)
      : new Patch(plan.source).axis('time', 's').replace(request.table, plan.ids)
    if (patch.byteLength > ENTRY_BYTES)
      throw problem('limit', 'Visualization identities exceed 16 MiB.')
    const empty = new Patch(plan.source).byteLength
    let runs = 0
    // The share of the frames read that the window sends, which sizes each read.
    const share = plan.picks
      ? Math.max(plan.picks.length, 1) / Math.max(plan.stop - plan.first, 1)
      : 1
    const entryBytes = 8 + plan.ids.length * 4
    // Disk blocks follow ingestion boundaries; a wire page combines them up to its byte
    // budget. This avoids one RPC per small live-ingestion block during later playback.
    page: while (plan.first + offset < plan.stop && runs < 64) {
      const first = plan.first + offset
      const block = this.#rawAt(first)
      if (runs && patch.byteLength + entryBytes + 256 > PAGE_BYTES) break
      let count = Math.min(
        plan.stop - first,
        block.first + block.count - first,
        Math.max(1, Math.floor((PAGE_BYTES - patch.byteLength - 1024) / (entryBytes * share))),
      )
      for (;;) {
        signal.throwIfAborted()
        const read = rawRun(
          await this.#stored(
            this.store.readRaw(block, plan.field, plan.places, first - block.first, count),
          ),
        )
        // The window sends the frames it shows of those read.
        const run = plan.picks ? picked(read, plan.picks, plan.ids.length) : read
        signal.throwIfAborted()
        const adds = run.at.length
          ? new Patch(plan.source).frames(request.table, request.field, run).byteLength - empty
          : 0
        if (patch.byteLength + adds <= PAGE_BYTES || (!runs && count === 1)) {
          if (patch.byteLength + adds > ENTRY_BYTES)
            throw problem('limit', 'A visualization frame exceeds 16 MiB.')
          if (run.at.length) {
            patch.frames(request.table, request.field, run)
            runs++
          }
          offset += count
          break
        }
        if (count === 1) break page
        count = Math.max(1, Math.floor(count / 2))
      }
    }
    const complete = plan.first + offset >= plan.stop
    const next: Cursor = { key: plan.key, frames: plan.frames, offset }
    return {
      key: plan.key,
      source: plan.source,
      table: request.table,
      field: request.field,
      bytes: patch.toBytes(),
      complete,
      ...(!complete && { next: JSON.stringify(next) }),
    }
  }
  /** A file of the time tiles of `request.field`, every recorded row or the one `id` names, as
   *  latkit's Tiles read them: the manifest, listing every frame read so far; the base dataset, the
   *  time axis and the rows, each with its place among them as `series`, which colors a plot's
   *  traces; or span `index` of `level`, the `chunk` entries from entry `index × chunk` on. A
   *  level's last span ends with the bucket still filling, which the next refresh fetches again. */
  async tile(request: TileRequest, signal: AbortSignal): Promise<Uint8Array> {
    const { table, file } = request
    const rows = this.#rows(
      table,
      request.field,
      request.id === undefined ? undefined : [request.id],
    )
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
  /** Up to `count` entries of `level` from entry `first` on, of the rows `rows` names, among
   *  `frames` frames: frames at level 0; above it, the buckets the store and the reducer hold, then
   *  the one still filling. */
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
        runs.push(
          rawRun(
            await this.#stored(this.store.readRaw(block, field, places, at - block.first, taken)),
          ),
        )
        at += taken
      }
      return runs
    }
    const whole = Math.floor(frames / 8 ** level)
    const stop = Math.min(whole, first + count)
    // Buckets reduced since the store last took them wait with the reducer.
    const waiting = this.#pending[field]?.get(level) ?? []
    for (let at = first; at < stop;) {
      signal.throwIfAborted()
      const block = this.#levelAt(field, level, at)
      if (block) {
        const taken = Math.min(stop, block.first + block.count) - at
        runs.push(await this.#stored(this.store.readLevel(block, places, at - block.first, taken)))
        at += taken
        continue
      }
      const run = waiting.find((each) => each.first === at)
      if (!run) throw lost(this.#layout.name, new Error('Missing visualization bucket.'))
      runs.push(selected(run, places, this.fields[field]!.ids.length))
      at++
    }
    const tail = this.#reducers[field]?.tail(level)
    if (tail && tail.first >= first && tail.first < first + count && tail.first === whole)
      runs.push(selected(tail, places, this.fields[field]!.ids.length))
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
