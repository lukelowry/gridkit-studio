/** Persistent scientific blocks and native visualization levels, committed by one atomic watermark. */
import { randomUUID } from 'node:crypto'
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { FrameBlock, TimeRange, VisualizationRun } from '../shared/data.js'
import { alive } from '../shared/processes.js'
import type { PyramidState, ReducedRun } from './pyramid.js'
import { same, type Stamp } from './stamp.js'

export const FORMAT = 'results-native-1'
export interface RawIndex {
  readonly kind: 'raw'
  readonly first: number
  readonly count: number
  readonly start: number
  readonly end: number
  readonly at: number
  readonly fields: readonly number[]
}
export interface LevelIndex {
  readonly kind: 'level'
  readonly field: number
  readonly level: number
  readonly first: number
  readonly count: number
  readonly start: number
  readonly end: number
  readonly at: number
  readonly values: number
  readonly gaps: number
  readonly gapped: readonly number[]
}
export interface Manifest {
  readonly format: typeof FORMAT
  readonly path: string
  readonly stamp: Stamp
  readonly read: number
  readonly fingerprint: string
  readonly header: readonly string[]
  readonly frames: number
  readonly chunk: number
  readonly domain: TimeRange
  readonly domains: Record<string, Record<string, TimeRange>>
  readonly visualErrors?: Readonly<Record<number, string>>
  readonly complete: boolean
  readonly rows: readonly number[]
  readonly rawBytes: number
  readonly levelBytes: number
  readonly indexBytes: number
  readonly reducers: readonly PyramidState[]
}
export type Checkpoint = Omit<
  Manifest,
  'format' | 'rows' | 'rawBytes' | 'levelBytes' | 'indexBytes'
>
export function fileKey(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? full.toLowerCase() : full
}
async function readAll(file: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  for (let read = 0; read < bytes.length;) {
    const { bytesRead } = await file.read(bytes, read, bytes.length - read, position + read)
    if (!bytesRead) throw new Error('A results store ends before its committed watermark.')
    read += bytesRead
  }
}
async function writeAll(file: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  for (let written = 0; written < bytes.length;) {
    const { bytesWritten } = await file.write(
      bytes,
      written,
      bytes.length - written,
      position + written,
    )
    if (!bytesWritten) throw new Error('A results store write made no progress.')
    written += bytesWritten
  }
}
async function manifestOf(folder: string): Promise<Manifest | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')) as Manifest
    if (
      manifest.format !== FORMAT ||
      !Array.isArray(manifest.rows) ||
      !Array.isArray(manifest.reducers) ||
      ![
        manifest.read,
        manifest.frames,
        manifest.rawBytes,
        manifest.levelBytes,
        manifest.indexBytes,
      ].every((value) => Number.isSafeInteger(value) && value >= 0)
    )
      return undefined
    return manifest
  } catch {
    return undefined
  }
}
export class Store {
  readonly raw: RawIndex[] = []
  readonly levels = new Map<string, LevelIndex[]>()
  #rows: readonly number[] = []
  #manifest?: Manifest
  #rawBytes = 0
  #levelBytes = 0
  #indexBytes = 0
  #files?: Promise<[FileHandle, FileHandle, FileHandle, FileHandle]>
  #restoring?: Promise<void>
  constructor(
    readonly folder: string,
    readonly key: string,
    manifest?: Manifest,
    private readonly owner?: Stores,
  ) {
    this.#manifest = manifest
    if (manifest) {
      this.#rows = manifest.rows
      this.#rawBytes = manifest.rawBytes
      this.#levelBytes = manifest.levelBytes
      this.#indexBytes = manifest.indexBytes
    }
  }
  get manifest(): Manifest | undefined {
    return this.#manifest
  }
  get bytes(): number {
    return (
      this.raw.length * (64 + this.#rows.length * 8) +
      [...this.levels.values()].reduce((n, blocks) => n + blocks.length * 96, 0)
    )
  }
  shape(rows: readonly number[], _chunk: number): void {
    if (this.#rows.length && JSON.stringify(rows) !== JSON.stringify(this.#rows))
      throw new Error('Result store shape changed.')
    this.#rows = [...rows]
  }
  #handles(): Promise<[FileHandle, FileHandle, FileHandle, FileHandle]> {
    return (this.#files ??= (async () => {
      const handles: FileHandle[] = []
      try {
        for (const name of ['raw.bin', 'levels.bin', 'index.jsonl', 'source.csv'])
          handles.push(await open(join(this.folder, name), this.#manifest ? 'r+' : 'w+'))
        return handles as [FileHandle, FileHandle, FileHandle, FileHandle]
      } catch (error) {
        await Promise.allSettled(handles.map((file) => file.close()))
        throw error
      }
    })())
  }
  async restore(): Promise<void> {
    return (this.#restoring ??= (async () => {
      const manifest = this.#manifest
      if (!manifest) return
      const files = await this.#handles()
      const sizes = [manifest.rawBytes, manifest.levelBytes, manifest.indexBytes, manifest.read]
      for (let i = 0; i < files.length; i++) {
        if ((await files[i]!.stat()).size < sizes[i]!)
          throw new Error('A committed result store is truncated.')
      }
      const bytes = new Uint8Array(manifest.indexBytes)
      await readAll(files[2], bytes, 0)
      this.raw.length = 0
      this.levels.clear()
      let expected = 0
      for (const line of new TextDecoder().decode(bytes).split('\n')) {
        if (!line) continue
        const index = JSON.parse(line) as RawIndex | LevelIndex
        if (
          !Number.isSafeInteger(index.first) ||
          !Number.isSafeInteger(index.count) ||
          index.first < 0 ||
          index.count < 1 ||
          !Number.isFinite(index.start) ||
          !Number.isFinite(index.end) ||
          index.end < index.start
        )
          throw new Error('Invalid results block index.')
        if (index.kind === 'raw') {
          if (index.first !== expected || index.fields.length !== this.#rows.length)
            throw new Error('Results block index is not consecutive.')
          expected += index.count
          this.raw.push(index)
        } else if (index.kind === 'level') this.#addLevel(index)
        else throw new Error('Unknown results index record.')
      }
      if (expected !== manifest.frames)
        throw new Error('Results checkpoint has a different frame count.')
      // Only bytes beyond the committed watermark are discarded after an interrupted write.
      for (let i = 0; i < files.length; i++) await files[i]!.truncate(sizes[i])
    })())
  }
  async #index(index: RawIndex | LevelIndex): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(index) + '\n')
    const files = await this.#handles()
    await writeAll(files[2], bytes, this.#indexBytes)
    this.#indexBytes += bytes.byteLength
  }
  #addLevel(index: LevelIndex): void {
    const key = `${index.field}:${index.level}`
    const blocks = this.levels.get(key) ?? []
    if (blocks.length && blocks.at(-1)!.first + blocks.at(-1)!.count !== index.first)
      throw new Error('Nonconsecutive visualization buckets.')
    blocks.push(index)
    this.levels.set(key, blocks)
  }
  async writeRaw(first: number, at: Float64Array, fields: readonly Float64Array[]): Promise<void> {
    if (!at.length) return
    const previous = this.raw.at(-1)
    if (
      first !== (previous ? previous.first + previous.count : 0) ||
      fields.length !== this.#rows.length
    )
      throw new Error('Nonconsecutive result frames.')
    const [file] = await this.#handles()
    const timeOffset = this.#rawBytes
    await writeAll(file, new Uint8Array(at.buffer, at.byteOffset, at.byteLength), this.#rawBytes)
    this.#rawBytes += at.byteLength
    const offsets: number[] = []
    for (let f = 0; f < fields.length; f++) {
      const rows = this.#rows[f]!
      const values = fields[f]!
      if (values.length !== rows * at.length) throw new Error('Invalid raw result dimensions.')
      const block = new Float64Array(values.length)
      for (let row = 0; row < rows; row++)
        for (let t = 0; t < at.length; t++) block[row * at.length + t] = values[t * rows + row]!
      offsets.push(this.#rawBytes)
      await writeAll(file, new Uint8Array(block.buffer), this.#rawBytes)
      this.#rawBytes += block.byteLength
    }
    const index: RawIndex = {
      kind: 'raw',
      first,
      count: at.length,
      start: at[0]!,
      end: at.at(-1)!,
      at: timeOffset,
      fields: offsets,
    }
    await this.#index(index)
    this.raw.push(index)
  }
  async writeLevel(field: number, level: number, runs: readonly ReducedRun[]): Promise<void> {
    if (!runs.length) return
    const rows = this.#rows[field]!
    const count = runs.length
    const at = new Float64Array(2 * count)
    const values = new Float32Array(rows * count * 2)
    const gaps = new Uint8Array(rows * count)
    runs.forEach((run, i) => {
      if (
        run.first !== runs[0]!.first + i ||
        run.level !== level ||
        run.at.length !== 2 ||
        run.values.length !== rows * 2
      )
        throw new Error('Invalid visualization bucket block.')
      at.set(run.at, 2 * i)
      values.set(run.values.subarray(0, rows), i * rows)
      values.set(run.values.subarray(rows), (count + i) * rows)
      gaps.set(run.gaps, i * rows)
    })
    const [, file] = await this.#handles()
    const timeOffset = this.#levelBytes
    await writeAll(file, new Uint8Array(at.buffer), this.#levelBytes)
    this.#levelBytes += at.byteLength
    const valueOffset = this.#levelBytes
    await writeAll(file, new Uint8Array(values.buffer), this.#levelBytes)
    this.#levelBytes += values.byteLength
    const gapOffset = this.#levelBytes
    await writeAll(file, gaps, this.#levelBytes)
    this.#levelBytes += gaps.byteLength
    const index: LevelIndex = {
      kind: 'level',
      field,
      level,
      first: runs[0]!.first,
      count,
      start: at[0]!,
      end: at.at(-1)!,
      at: timeOffset,
      values: valueOffset,
      gaps: gapOffset,
      gapped: runs
        .filter((run) => run.gaps.some((gap, row) => gap !== 0 && Number.isFinite(run.values[row])))
        .map((run) => run.first),
    }
    await this.#index(index)
    this.#addLevel(index)
  }
  async times(index: RawIndex, offset = 0, count = index.count - offset): Promise<Float64Array> {
    if (offset < 0 || count < 0 || offset + count > index.count)
      throw new Error('Invalid time slice.')
    const [file] = await this.#handles()
    const at = new Float64Array(count)
    await readAll(file, new Uint8Array(at.buffer), index.at + offset * 8)
    return at
  }
  async readRaw(
    index: RawIndex,
    field: number,
    places?: readonly number[],
    offset = 0,
    count = index.count - offset,
  ): Promise<FrameBlock> {
    const at = await this.times(index, offset, count)
    const [file] = await this.#handles()
    const selected = places ?? Array.from({ length: this.#rows[field]! }, (_, i) => i)
    const values = new Float64Array(count * selected.length)
    for (const place of selected) {
      if (!Number.isSafeInteger(place) || place < 0 || place >= this.#rows[field]!)
        throw new Error('Invalid recorded row.')
    }
    // Rows are contiguous on disk. Read adjacent selections together, bounded to 4 MiB,
    // then transpose directly into the requested order. A single-row inspection still
    // reads only its requested times, rather than the whole field or run.
    const order = Array.from({ length: selected.length }, (_, i) => i).sort(
      (a, b) => selected[a]! - selected[b]!,
    )
    for (let first = 0; first < order.length;) {
      const place = selected[order[first]!]!
      let stop = first + 1
      while (
        stop < order.length &&
        selected[order[stop]!] === place + stop - first &&
        ((stop - first) * index.count + count) * 8 <= 4 * 1024 * 1024
      )
        stop++
      const block = new Float64Array((stop - first - 1) * index.count + count)
      await readAll(
        file,
        new Uint8Array(block.buffer),
        index.fields[field]! + (place * index.count + offset) * 8,
      )
      for (let row = first; row < stop; row++)
        for (let t = 0; t < count; t++)
          values[t * selected.length + order[row]!] = block[(row - first) * index.count + t]!
      first = stop
    }
    return { first: index.first + offset, rows: selected.length, at, values }
  }
  async readLevel(
    index: LevelIndex,
    places: readonly number[],
    offset = 0,
    count = index.count - offset,
  ): Promise<VisualizationRun & { gaps: Uint8Array }> {
    if (offset < 0 || count < 0 || offset + count > index.count)
      throw new Error('Invalid level slice.')
    const [, file] = await this.#handles()
    const rows = this.#rows[index.field]!
    const at = new Float64Array(count * 2)
    await readAll(file, new Uint8Array(at.buffer), index.at + offset * 16)
    const values = new Float32Array(places.length * count * 2)
    const gaps = new Uint8Array(places.length * count)
    // Disk values are frame-major, with a separate plane for maxima, matching Patch.frames.
    const low = new Float32Array(count * rows)
    const high = new Float32Array(count * rows)
    const missing = new Uint8Array(count * rows)
    await readAll(file, new Uint8Array(low.buffer), index.values + offset * rows * 4)
    await readAll(
      file,
      new Uint8Array(high.buffer),
      index.values + (index.count + offset) * rows * 4,
    )
    await readAll(file, missing, index.gaps + offset * rows)
    for (let t = 0; t < count; t++)
      for (let r = 0; r < places.length; r++) {
        values[t * places.length + r] = low[t * rows + places[r]!]!
        values[(count + t) * places.length + r] = high[t * rows + places[r]!]!
        gaps[t * places.length + r] = missing[t * rows + places[r]!]!
      }
    return { level: index.level, first: index.first + offset, at, values, gaps }
  }
  async writeCsv(bytes: Uint8Array, position: number): Promise<void> {
    const files = await this.#handles()
    await writeAll(files[3], bytes, position)
  }
  async checkpoint(value: Checkpoint): Promise<void> {
    const files = await this.#handles()
    await Promise.all(files.map((file) => file.sync()))
    const written: Manifest = {
      ...value,
      format: FORMAT,
      rows: this.#rows,
      rawBytes: this.#rawBytes,
      levelBytes: this.#levelBytes,
      indexBytes: this.#indexBytes,
    }
    const draft = join(this.folder, 'manifest.json.draft')
    await writeFile(draft, JSON.stringify(written), { flush: true })
    await rename(draft, join(this.folder, 'manifest.json'))
    this.#manifest = written
    await this.owner?.finished(this)
  }
  async intact(): Promise<boolean> {
    try {
      await this.restore()
      return true
    } catch {
      return false
    }
  }
  async close(remove = false): Promise<void> {
    const files = this.#files
    this.#files = undefined
    await files
      ?.then((handles) => Promise.allSettled(handles.map((file) => file.close())))
      .catch(() => {})
    if (remove) await rm(this.folder, { recursive: true, force: true })
  }
}

export class Stores {
  /** The latest store read through of each results file, by its key. */
  readonly #latest = new Map<string, Store>()
  /** The stores of the results files read now, and how many read each. */
  readonly #using = new Map<Store, number>()
  /** The sweep the stores wait for before any is made or found. */
  #swept: Promise<void> = Promise.resolve()
  /** This window's own stores. */
  readonly #own: string

  constructor(
    readonly root: string,
    owner = process.pid,
  ) {
    this.root = join(root, FORMAT)
    this.#own = join(this.root, String(owner))
  }

  /** Keeps the latest store read through of each results file `kept` names, of this window's and
   *  of the windows since gone, whose stores it takes as its own, and removes the rest of those:
   *  stores never read through, those of files no saved session names, and those a later store
   *  took the place of. A window still open keeps its own, whatever they hold. Asked as the worker
   *  starts, before it reads anything. */
  sweep(kept: readonly string[]): Promise<void> {
    return (this.#swept = this.#sweep(new Set(kept.map(fileKey))))
  }

  async #sweep(named: ReadonlySet<string>): Promise<void> {
    await mkdir(this.#own, { recursive: true })
    for (const name of await readdir(this.root).catch(() => [])) {
      const folder = join(this.root, name)
      const window = /^\d+$/.test(name) ? Number(name) : undefined
      if (folder === this.#own || (window !== undefined && alive(window))) continue
      // A window gone leaves its stores to the next, moved within one folder, never copied; what
      // is no window's folder is no store of Studio's now.
      if (window !== undefined)
        for (const store of await readdir(folder).catch(() => []))
          await rename(join(folder, store), join(this.#own, store)).catch(() => {})
      await rm(folder, { recursive: true, force: true })
    }
    const names = await readdir(this.#own).catch(() => [])
    const found = await Promise.all(
      names.map(async (name) => {
        const folder = join(this.#own, name)
        return { folder, manifest: await manifestOf(folder) }
      }),
    )
    const removed: string[] = []
    for (const { folder, manifest } of found) {
      const key = manifest && fileKey(manifest.path)
      if (!key || !named.has(key)) {
        removed.push(folder)
        continue
      }
      const latest = this.#latest.get(key)
      if (latest && BigInt(latest.manifest!.stamp.modified) >= BigInt(manifest.stamp.modified))
        removed.push(folder)
      else {
        if (latest) removed.push(latest.folder)
        this.#latest.set(key, new Store(folder, key, manifest, this))
      }
    }
    await Promise.all(removed.map((folder) => rm(folder, { recursive: true, force: true })))
  }

  #use(store: Store): Store {
    this.#using.set(store, (this.#using.get(store) ?? 0) + 1)
    return store
  }

  /** A new store of the results file at `path`, to keep its frames as they are read. */
  async create(path: string): Promise<Store> {
    await this.#swept
    const folder = join(this.#own, randomUUID())
    await mkdir(folder, { recursive: true })
    return this.#use(new Store(folder, fileKey(path), undefined, this))
  }

  /** The store read through of the results file at `path`, which `now` stamps, matched against a
   *  case of `fingerprint`: the latest, when it read that same file as it stands now. */
  async find(path: string, now: Stamp, fingerprint: string): Promise<Store | undefined> {
    await this.#swept
    const store = this.#latest.get(fileKey(path))
    const manifest = store?.manifest
    if (
      !store ||
      !manifest ||
      (!same(manifest.stamp, now) &&
        (manifest.complete || manifest.stamp.file !== now.file || now.size < manifest.read)) ||
      manifest.fingerprint !== fingerprint
    )
      return undefined
    return this.#use(store)
  }

  /** A reader of `store` found it would not read: it is let go of, and goes, so the file it holds
   *  is read again from its CSV. */
  async discard(store: Store): Promise<void> {
    if (this.#latest.get(store.key) === store) this.#latest.delete(store.key)
    await this.release(store)
  }

  /** `store` was read through: the latest of its results file, which the one before gives way to. */
  async finished(store: Store): Promise<void> {
    const before = this.#latest.get(store.key)
    this.#latest.set(store.key, store)
    if (before && before !== store && !this.#using.has(before)) await before.close(true)
  }

  /** A reader of `store` lets go of it. Once none reads it, it closes: and it goes, never read
   *  through, or once a later store took its place. */
  async release(store: Store): Promise<void> {
    const readers = (this.#using.get(store) ?? 1) - 1
    if (readers > 0) {
      this.#using.set(store, readers)
      return
    }
    this.#using.delete(store)
    await store.close(!store.manifest || this.#latest.get(store.key) !== store)
  }
}
