/** Scientific results stay on disk; requests read bounded windows by actual timestamps. */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { type Id, Patch } from 'latkit'

import type { Case } from '../gridkit/case.js'
import { CaseQueries } from '../gridkit/projection.js'
import {
  ENTRY_BYTES,
  type ExactSample,
  type ExactSampleRequest,
  type FramePage,
  type FrameRequest,
  PAGE_BYTES,
  type TimeRange,
  type VisualizationRun,
} from '../shared/data.js'
import { message, problem } from '../shared/errors.js'
import type { ResultsLayout, ResultsProgress, Revision } from '../shared/messages.js'
import type { ResultCache } from './cache.js'
import {
  chunkFrames,
  type Decoded,
  type Field,
  type Layout,
  layoutFrom,
  readResults,
  recordedFields,
} from './decode.js'
import { follow, type Writer } from './follow.js'
import { rawRun } from './frames.js'
import { Pyramid, type ReducedRun } from './pyramid.js'
import { same, type Stamp, stampAt } from './stamp.js'
import { fileKey, type LevelIndex, type RawIndex, type Store } from './store.js'

export const closed = () => problem('results-closed', 'These results are closed.')
export const lost = (name: string, cause: unknown) =>
  problem('results-lost', `What Studio kept of ${name} could not be read.`, { cause })
export interface Reading {
  readonly revision: Revision
  readonly path: string
  readonly solver?: string
  readonly span?: TimeRange
}
interface Interval {
  level: number
  first: number
  count: number
}
interface FramePlan {
  key: string
  source: string
  field: number
  ids: readonly Id[]
  places: readonly number[]
  intervals: readonly Interval[]
  frames: number
}
interface Cursor {
  key: string
  frames: number
  part: number
  offset: number
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

export class ResultsFile {
  #layout: ResultsLayout
  readonly #progress: { -readonly [K in keyof ResultsProgress]: ResultsProgress[K] }
  readonly #decode: Layout = {}
  readonly #readers = new Map<AbortController, Promise<void>>()
  readonly #plans = new Map<string, FramePlan>()
  #reducers: Pyramid[] = []
  #pending: Map<number, ReducedRun[]>[] = []
  #visualErrors: Record<number, string> = {}
  #opened?: Stamp
  #stamp?: Stamp
  #read = 0
  #retired = false
  #queries?: CaseQueries
  constructor(
    readonly kase: Case,
    readonly cache: ResultCache,
    readonly store: Store,
    { revision, path, solver, span }: Reading,
  ) {
    this.#layout = {
      revision: { ...revision },
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
  static async stored(
    kase: Case,
    cache: ResultCache,
    store: Store,
    reading: Reading,
  ): Promise<ResultsFile> {
    await store.restore()
    const manifest = store.manifest!
    const file = new ResultsFile(kase, cache, store, reading)
    Object.assign(file.#decode, layoutFrom(manifest.header, kase))
    file.#learned(manifest.chunk)
    file.#reducers.forEach((reducer, i) => reducer.restore(manifest.reducers[i]!))
    file.#visualErrors = { ...manifest.visualErrors }
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
  get queries(): CaseQueries {
    return (this.#queries ??= new CaseQueries(this.kase.projected()))
  }
  idle(): void {
    this.#queries?.destroy()
    this.#queries = undefined
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
    this.cache.drop(this)
  }
  async #verifyPrefix(signal: AbortSignal): Promise<void> {
    const original = await open(this.#layout.path, 'r')
    const cached = await open(join(this.store.folder, 'source.csv'), 'r')
    try {
      const a = Buffer.alloc(64 << 10)
      const b = Buffer.alloc(64 << 10)
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
          !a.subarray(0, length).equals(b.subarray(0, length))
        )
          throw new Error('The results changed before the committed watermark; reopen the file.')
        at += length
      }
    } finally {
      await Promise.allSettled([original.close(), cached.close()])
    }
  }
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
            Readable.from([piece.bytes]),
            this.kase,
            { signal, publish: () => {} },
            this.#decode,
          )
          this.#learned(chunkFrames(this.fields))
          await this.store.writeCsv(piece.bytes, this.#read)
          this.#read += piece.bytes.length
        } else if (piece.kind === 'segment') {
          await readResults(
            Readable.from([piece.bytes]),
            this.kase,
            { signal, first: this.#progress.frames, publish: (frames) => this.#add(frames) },
            this.#decode,
          )
          await this.store.writeCsv(piece.bytes, this.#read)
          this.#read += piece.bytes.length
          await this.#checkpoint(false)
          await progress()
        } else this.#stamp = piece.stamp
      }
      await this.#checkpoint(!!this.#stamp)
    } catch (error) {
      if (!signal.aborted) this.#progress.error = message(error)
      throw error
    } finally {
      this.#progress.growing = false
    }
  }
  #learned(chunk: number): void {
    this.#layout = { ...this.#layout, outputs: recordedFields(this.fields), chunk }
    this.store.shape(
      this.fields.map((field) => field.ids.length),
      chunk,
    )
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
    const progress = this.#progress
    if (
      frames.firstFrame !== progress.frames ||
      frames.coordinates[0]! < (progress.frames ? progress.domain[1] : -Infinity)
    )
      throw new Error('Result times must be nondecreasing.')
    await this.store.writeRaw(frames.firstFrame, frames.coordinates, frames.values)
    const domains = (progress.domains ??= {})
    this.fields.forEach((field, f) => {
      const ranges = (domains[field.table] ??= {})
      let [min, max] = ranges[field.field] ?? [Infinity, -Infinity]
      for (const value of frames.values[f]!)
        if (Number.isFinite(value)) {
          min = Math.min(min, value)
          max = Math.max(max, value)
        }
      if (min <= max) ranges[field.field] = [min, max]
      if (!this.#visualErrors[f]) {
        try {
          this.#reducers[f]!.push(frames.firstFrame, frames.coordinates, frames.values[f]!)
        } catch (error) {
          if ((error as { code?: string }).code !== 'limit') throw error
          this.#visualErrors[f] = message(error)
        }
      }
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
  async #checkpoint(complete: boolean): Promise<void> {
    if (!this.#decode.header || !this.#opened) return
    await this.#flushLevels()
    await this.store.checkpoint({
      path: this.#layout.path,
      stamp: this.#stamp ?? this.#opened,
      read: this.#read,
      fingerprint: this.kase.version,
      header: this.#decode.header,
      frames: this.#progress.frames,
      chunk: this.#layout.chunk,
      domain: this.#progress.domain,
      domains: this.#progress.domains ?? {},
      complete,
      reducers: this.#reducers.map((reducer) => reducer.snapshot()),
      visualErrors: this.#visualErrors,
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
  #intervals(field: number, level: number, first: number, stop: number): Interval[] {
    const result: Interval[] = []
    const add = (level: number, first: number, count: number) => {
      if (!count) return
      const previous = result.at(-1)
      if (previous?.level === level && previous.first + previous.count === first)
        previous.count += count
      else result.push({ level, first, count })
    }
    const cover = (level: number, first: number, stop: number) => {
      if (stop <= first) return
      if (level === 0) {
        add(0, first, stop - first)
        return
      }
      const stride = 8 ** level
      const start = Math.ceil(first / stride)
      const end = Math.floor(stop / stride)
      if (start >= end) {
        cover(level - 1, first, stop)
        return
      }
      cover(level - 1, first, start * stride)
      let bucket = start
      while (bucket < end) {
        const block = this.#levelAt(field, level, bucket)
        if (!block) {
          cover(level - 1, bucket * stride, end * stride)
          break
        }
        const until = Math.min(end, block.first + block.count)
        // Refine only buckets containing gaps. One missing sample must not expand an
        // entire disk block into raw frames and exhaust the visualization budget.
        let gap = lowerBound(block.gapped.length, (i) => block.gapped[i]! >= bucket)
        while (gap < block.gapped.length && block.gapped[gap]! < until) {
          const missing = block.gapped[gap++]!
          add(level, bucket, missing - bucket)
          cover(level - 1, missing * stride, (missing + 1) * stride)
          bucket = missing + 1
        }
        add(level, bucket, until - bucket)
        bucket = until
      }
      cover(level - 1, end * stride, stop)
    }
    cover(level, first, stop)
    return result
  }
  async #plan(request: FrameRequest, frames: number, signal: AbortSignal): Promise<FramePlan> {
    if (
      !Number.isFinite(request.range[0]) ||
      !Number.isFinite(request.range[1]) ||
      request.range[1] < request.range[0] ||
      !Number.isFinite(request.pixels) ||
      request.pixels < 1 ||
      !Number.isSafeInteger(request.bytes) ||
      request.bytes < 1024 ||
      request.bytes > 96 * 1024 * 1024 ||
      frames > this.#progress.frames ||
      frames < 0
    )
      throw new Error('Invalid result window.')
    const field = this.fields.findIndex(
      (item) => item.table === request.table && item.field === request.field,
    )
    if (field < 0) throw new Error('The requested field was not recorded.')
    const held = this.fields[field]!.ids
    const ids = request.ids ? [...new Set(request.ids)] : [...held]
    const positions = new Map(held.map((id, index) => [id, index]))
    const places = ids.map((id) => {
      const row = positions.get(id)
      if (row === undefined) throw new Error('The requested identity was not recorded.')
      return row
    })
    if (!places.length) throw new Error('Choose at least one recorded row.')
    const base = JSON.stringify([this.store.folder, request.table, request.field, ids])
    const source = 'sample:' + createHash('sha256').update(base).digest('hex').slice(0, 20)
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          base,
          frames,
          request.range,
          request.purpose,
          request.pixels,
          request.bytes,
        ]),
      )
      .digest('hex')
    const kept = this.#plans.get(key)
    if (kept) return kept
    const first = frames
      ? Math.max(
          0,
          (await this.#bound(request.range[0], request.purpose === 'playhead', frames)) - 1,
        )
      : 0
    const stop = frames
      ? Math.min(frames, (await this.#bound(request.range[1], true, frames)) + 1)
      : 0
    let intervals: Interval[] = []
    for (let level = 0; level <= 21; level++) {
      signal.throwIfAborted()
      intervals = this.#intervals(field, level, first, stop)
      const entries = intervals.reduce((sum, item) => sum + item.count * (item.level ? 2 : 1), 0)
      const bytes = entries * (8 + places.length * 4) + intervals.length * 128 + ids.length * 16
      if (
        bytes <= request.bytes &&
        (request.purpose === 'playhead' || entries <= request.pixels * 2 || level === 21)
      )
        break
      if (request.purpose === 'playhead' || level === 21)
        throw problem(
          'limit',
          'This window exceeds the visualization budget. Choose fewer rows or a narrower time range.',
        )
    }
    const plan: FramePlan = { key, source, field, ids, places, intervals, frames }
    this.#plans.set(key, plan)
    while (this.#plans.size > 16) this.#plans.delete(this.#plans.keys().next().value!)
    return plan
  }
  async frames(request: FrameRequest & { next?: string }, signal: AbortSignal): Promise<FramePage> {
    let cursor: Cursor | undefined
    if (request.next) {
      if (request.next.length > 1024) throw new Error('Invalid frame cursor.')
      cursor = JSON.parse(request.next) as Cursor
      if (
        ![cursor.frames, cursor.part, cursor.offset].every((n) => Number.isSafeInteger(n) && n >= 0)
      )
        throw new Error('Invalid frame cursor.')
    }
    const plan = await this.#plan(request, cursor?.frames ?? this.#progress.frames, signal)
    if (cursor && cursor.key !== plan.key) throw new Error('The result window changed.')
    let part = cursor?.part ?? 0
    let offset = cursor?.offset ?? 0
    const initial = plan.intervals[part]
    if (cursor && (!initial || offset >= initial.count))
      throw new Error('Frame cursor exceeds its window.')
    const make = () =>
      cursor
        ? new Patch(plan.source)
        : new Patch(plan.source).axis('time', 's').replace(request.table, plan.ids)
    const runs: VisualizationRun[] = []
    let bytes = make().toBytes()
    if (bytes.byteLength > ENTRY_BYTES)
      throw problem('limit', 'Visualization identities exceed 16 MiB.')
    // Disk blocks follow ingestion boundaries; a wire page combines them up to its byte
    // budget. This avoids one RPC per small live-ingestion block during later playback.
    page: while (part < plan.intervals.length && runs.length < 64) {
      const interval = plan.intervals[part]!
      const first = interval.first + offset
      const block =
        interval.level === 0
          ? this.#rawAt(first)
          : this.#levelAt(plan.field, interval.level, first)!
      const entryBytes = (interval.level ? 2 : 1) * (8 + plan.ids.length * 4)
      if (runs.length && bytes.byteLength + entryBytes + 256 > PAGE_BYTES) break
      let count = Math.min(
        interval.count - offset,
        block.first + block.count - first,
        Math.max(1, Math.floor((PAGE_BYTES - bytes.byteLength - 1024) / entryBytes)),
      )
      for (;;) {
        signal.throwIfAborted()
        const run =
          interval.level === 0
            ? rawRun(
                await this.#stored(
                  this.store.readRaw(
                    block as RawIndex,
                    plan.field,
                    plan.places,
                    first - block.first,
                    count,
                  ),
                ),
              )
            : await this.#stored(
                this.store.readLevel(block as LevelIndex, plan.places, first - block.first, count),
              )
        signal.throwIfAborted()
        const patch = make()
        for (const held of runs) patch.frames(request.table, request.field, held)
        const encoded = patch.frames(request.table, request.field, run).toBytes()
        if (encoded.byteLength <= PAGE_BYTES || (!runs.length && count === 1)) {
          if (encoded.byteLength > ENTRY_BYTES)
            throw problem('limit', 'A visualization frame exceeds 16 MiB.')
          runs.push(run)
          bytes = encoded
          offset += count
          if (offset === interval.count) {
            part++
            offset = 0
          }
          break
        }
        if (count === 1) break page
        count = Math.max(1, Math.floor(count / 2))
      }
    }
    const complete = part === plan.intervals.length
    const next: Cursor = { key: plan.key, frames: plan.frames, part, offset }
    return {
      key: plan.key,
      source: plan.source,
      table: request.table,
      field: request.field,
      bytes,
      complete,
      ...(!complete && { next: JSON.stringify(next) }),
    }
  }
  async exportCsv(path: string): Promise<void> {
    if (this.of(path)) throw new Error('Choose a different file from the open results.')
    if (!this.#read) throw new Error('No results have been read yet.')
    const source = await open(join(this.store.folder, 'source.csv'), 'r')
    const draft = `${path}.${randomUUID().slice(0, 8)}.part`
    try {
      await mkdir(dirname(path), { recursive: true })
      await pipeline(
        source.createReadStream({ start: 0, end: this.#read - 1, autoClose: false }),
        createWriteStream(draft),
      )
      await rename(draft, path)
    } finally {
      await rm(draft, { force: true })
      await source.close()
    }
  }
}
