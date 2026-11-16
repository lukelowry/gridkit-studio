/** On-disk result blocks and visualization levels, committed by one atomic manifest write. */
import { randomUUID } from '../platform/crypto.js'
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from '../platform/files.js'
import { alive, caseless, owner as ownerId } from '../platform/host.js'
import { dirname, join, resolve } from '../platform/path.js'
import type { TimeRange } from '../shared/data.js'
import { problem } from '../shared/errors.js'
import type { LongColumns } from './csv.js'
import type { FrameBlock, VisualizationRun } from './frames.js'
import type { PyramidState } from './pyramid.js'
import { same, type Stamp } from './stamp.js'

export const FORMAT = 'results-native-4'
/** A store that no longer matches its manifest, so the results file must be read again. */
export const lost = (message: string, cause?: unknown) =>
  problem('results-lost', message, cause === undefined ? {} : { cause })
const READ_BYTES = 4 << 20
/** Raw frames on disk: the times, then each field's values, row by row. */
export interface RawIndex {
  readonly kind: 'raw'
  readonly first: number
  readonly count: number
  readonly start: number
  readonly end: number
  readonly at: number
  readonly fields: readonly number[]
}
/** One field's buckets at one level: their times, then minimums and maximums, row by row. */
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
}
/** A store's committed state. A sweep reads it for every store, so it stays small. */
export interface Manifest {
  readonly format: typeof FORMAT
  readonly path: string
  readonly stamp: Stamp
  readonly read: number
  readonly fingerprint: string
  /** Column positions for a file in GridKit's long layout (one row per variable and sample). */
  readonly long?: LongColumns
  readonly frames: number
  readonly domain: TimeRange
  readonly domains: Record<string, Record<string, TimeRange>>
  readonly complete: boolean
  readonly rows: readonly number[]
  readonly rawBytes: number
  readonly levelBytes: number
  readonly indexBytes: number
}
/** The state a resumed read needs, kept apart from the manifest because it grows with the file. */
export interface Resume {
  readonly header: readonly string[]
  readonly reducers: readonly PyramidState[]
}
export type Checkpoint = Omit<
  Manifest,
  'format' | 'rows' | 'rawBytes' | 'levelBytes' | 'indexBytes'
> &
  Resume
export function fileKey(path: string): string {
  const full = resolve(path)
  return caseless ? full.toLowerCase() : full
}
const missing = (error: unknown) => (error as { code?: unknown } | null)?.code === 'ENOENT'
async function readAll(file: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  for (let read = 0; read < bytes.length;) {
    const { bytesRead } = await file.read(bytes, read, bytes.length - read, position + read)
    if (!bytesRead) throw lost('A results store ends before what it says it holds.')
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
/** Removes `folder` if possible. One that Windows keeps open is left for a later sweep. */
const removeFolder = (folder: string) =>
  rm(folder, { recursive: true, force: true }).catch(() => {})
async function manifestOf(folder: string): Promise<Manifest | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8')) as Manifest
    if (
      manifest.format !== FORMAT ||
      !Array.isArray(manifest.rows) ||
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
  /** Cached per selection, because a window reads many blocks with one selection. */
  readonly #orders = new WeakMap<readonly number[], { rows: number; order: Uint32Array }>()
  #manifest?: Manifest
  #rawBytes = 0
  #levelBytes = 0
  #indexBytes = 0
  #files?: Promise<[FileHandle, FileHandle, FileHandle, FileHandle]>
  #restoring?: Promise<Resume | undefined>
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
  shape(rows: readonly number[]): void {
    if (this.#rows.length && JSON.stringify(rows) !== JSON.stringify(this.#rows))
      throw new Error('Result store shape changed.')
    this.#rows = [...rows]
  }
  #handles(): Promise<[FileHandle, FileHandle, FileHandle, FileHandle]> {
    if (this.#files) return this.#files
    const opening = (this.#files = (async () => {
      const handles: FileHandle[] = []
      try {
        for (const name of ['raw.bin', 'levels.bin', 'index.jsonl', 'source.csv'])
          handles.push(await open(join(this.folder, name), this.#manifest ? 'r+' : 'w+'))
        return handles as [FileHandle, FileHandle, FileHandle, FileHandle]
      } catch (error) {
        await Promise.allSettled(handles.map((file) => file.close()))
        // A file the manifest lists that is missing means the store is lost.
        throw this.#manifest && missing(error)
          ? lost('A results store lacks a file it holds.', error)
          : error
      }
    })())
    opening.catch(() => {
      if (this.#files === opening) this.#files = undefined
    })
    return opening
  }
  /** Loads the last checkpoint once per open, truncating anything written after it. */
  restore(): Promise<Resume | undefined> {
    if (this.#restoring) return this.#restoring
    const restoring = (this.#restoring = this.#restore())
    restoring.catch(() => {
      if (this.#restoring === restoring) this.#restoring = undefined
    })
    return restoring
  }
  async #restore(): Promise<Resume | undefined> {
    const manifest = this.#manifest
    if (!manifest) return undefined
    const files = await this.#handles()
    const sizes = [manifest.rawBytes, manifest.levelBytes, manifest.indexBytes, manifest.read]
    for (let i = 0; i < files.length; i++) {
      if ((await files[i]!.stat()).size < sizes[i]!)
        throw lost('A committed result store is truncated.')
    }
    let resume: Resume & { read?: unknown; frames?: unknown }
    try {
      resume = JSON.parse(await readFile(join(this.folder, 'resume.json'), 'utf8')) as typeof resume
    } catch (error) {
      if (error instanceof SyntaxError || missing(error))
        throw lost('A results store lacks what a read takes it up with.', error)
      throw error
    }
    if (
      resume.read !== manifest.read ||
      resume.frames !== manifest.frames ||
      !Array.isArray(resume.header) ||
      !Array.isArray(resume.reducers)
    )
      throw lost('A results store was only partly written.')
    const bytes = new Uint8Array(manifest.indexBytes)
    await readAll(files[2], bytes, 0)
    this.raw.length = 0
    this.levels.clear()
    let expected = 0
    try {
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
    } catch (error) {
      throw lost('A results store is damaged.', error)
    }
    // Discard bytes past the checkpoint, left by an interrupted write.
    for (let i = 0; i < files.length; i++) await files[i]!.truncate(sizes[i])
    this.#rawBytes = manifest.rawBytes
    this.#levelBytes = manifest.levelBytes
    this.#indexBytes = manifest.indexBytes
    return { header: resume.header, reducers: resume.reducers }
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
  async writeLevel(field: number, level: number, runs: readonly VisualizationRun[]): Promise<void> {
    if (!runs.length) return
    const rows = this.#rows[field]!
    const count = runs.length
    const at = new Float64Array(2 * count)
    const values = new Float32Array(rows * count * 2)
    runs.forEach((run, i) => {
      if (
        run.first !== runs[0]!.first + i ||
        run.level !== level ||
        run.at.length !== 2 ||
        run.values.length !== rows * 2
      )
        throw new Error('Invalid visualization bucket block.')
      at.set(run.at, 2 * i)
      // Row by row, like raw frames, so a plot of a few rows reads only those rows.
      for (let row = 0; row < rows; row++) {
        values[row * count + i] = run.values[row]!
        values[(rows + row) * count + i] = run.values[rows + row]!
      }
    })
    const [, file] = await this.#handles()
    const timeOffset = this.#levelBytes
    await writeAll(file, new Uint8Array(at.buffer), this.#levelBytes)
    this.#levelBytes += at.byteLength
    const valueOffset = this.#levelBytes
    await writeAll(file, new Uint8Array(values.buffer), this.#levelBytes)
    this.#levelBytes += values.byteLength
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
  /** Indexes into `selected` in disk order. */
  #order(selected: readonly number[], rows: number): Uint32Array {
    const known = this.#orders.get(selected)
    if (known?.rows === rows) return known.order
    for (const place of selected)
      if (!Number.isSafeInteger(place) || place < 0 || place >= rows)
        throw new Error('Invalid recorded row.')
    const order = Uint32Array.from(selected, (_, i) => i).sort(
      (a, b) => selected[a]! - selected[b]!,
    )
    this.#orders.set(selected, { rows, order })
    return order
  }
  /** Reads `count` entries of each selected row of a plane of `rows` rows by `span` entries,
   *  merging adjacent rows into reads of about READ_BYTES. */
  async #plane<T extends Float64Array | Float32Array>(
    file: FileHandle,
    start: number,
    span: number,
    rows: number,
    selected: readonly number[],
    offset: number,
    count: number,
    into: T,
    base = 0,
  ): Promise<void> {
    const width = into.BYTES_PER_ELEMENT
    const order = this.#order(selected, rows)
    for (let first = 0; first < order.length;) {
      const place = selected[order[first]!]!
      let stop = first + 1
      while (
        stop < order.length &&
        selected[order[stop]!] === place + stop - first &&
        ((stop - first) * span + count) * width <= READ_BYTES
      )
        stop++
      const block = new (into.constructor as new (length: number) => T)(
        (stop - first - 1) * span + count,
      )
      await readAll(file, new Uint8Array(block.buffer), start + (place * span + offset) * width)
      for (let row = first; row < stop; row++)
        for (let t = 0; t < count; t++)
          into[(base + t) * selected.length + order[row]!] = block[(row - first) * span + t]!
      first = stop
    }
  }
  async readRaw(
    index: RawIndex,
    field: number,
    places: readonly number[],
    offset = 0,
    count = index.count - offset,
  ): Promise<FrameBlock> {
    const at = await this.times(index, offset, count)
    const [file] = await this.#handles()
    const values = new Float64Array(count * places.length)
    await this.#plane(
      file,
      index.fields[field]!,
      index.count,
      this.#rows[field]!,
      places,
      offset,
      count,
      values,
    )
    return { first: index.first + offset, at, values }
  }
  async readLevel(
    index: LevelIndex,
    places: readonly number[],
    offset = 0,
    count = index.count - offset,
  ): Promise<VisualizationRun> {
    if (offset < 0 || count < 0 || offset + count > index.count)
      throw new Error('Invalid level slice.')
    const [, file] = await this.#handles()
    const rows = this.#rows[index.field]!
    const at = new Float64Array(count * 2)
    await readAll(file, new Uint8Array(at.buffer), index.at + offset * 16)
    // Every bucket's minimums, then every bucket's maximums, as Patch.frames expects.
    const values = new Float32Array(places.length * count * 2)
    const greatest = index.values + rows * index.count * values.BYTES_PER_ELEMENT
    await this.#plane(file, index.values, index.count, rows, places, offset, count, values)
    await this.#plane(file, greatest, index.count, rows, places, offset, count, values, count)
    return { level: index.level, first: index.first + offset, at, values }
  }
  async writeCsv(bytes: Uint8Array, position: number): Promise<void> {
    const files = await this.#handles()
    await writeAll(files[3], bytes, position)
  }
  /** Commits the store once every file is synced. resume.json goes first, so a manifest that
   *  disagrees with it marks a partial commit. */
  async checkpoint({ header, reducers, ...value }: Checkpoint): Promise<void> {
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
    const write = async (name: string, content: object) => {
      const draft = join(this.folder, `${name}.draft`)
      await writeFile(draft, JSON.stringify(content), { flush: true })
      await rename(draft, join(this.folder, name))
    }
    await write('resume.json', { read: value.read, frames: value.frames, header, reducers })
    await write('manifest.json', written)
    this.#manifest = written
    // A later restore while the store is open returns the state just written.
    this.#restoring = Promise.resolve({ header, reducers })
    await this.owner?.finished(this)
  }
  async close(remove = false): Promise<void> {
    const files = this.#files
    this.#files = undefined
    this.#restoring = undefined
    await files
      ?.then((handles) => Promise.allSettled(handles.map((file) => file.close())))
      .catch(() => {})
    if (remove) await removeFolder(this.folder)
  }
}

export class Stores {
  /** The latest committed store of each results file. */
  readonly #latest = new Map<string, Store>()
  /** Reader counts. */
  readonly #using = new Map<Store, number>()
  #swept: Promise<void> = Promise.resolve()
  readonly #own: string

  constructor(
    readonly root: string,
    owner: string | number = ownerId,
  ) {
    this.root = join(root, FORMAT)
    this.#own = join(this.root, String(owner))
  }

  /** Adopts closed windows' stores and keeps the latest committed store of each file in `kept`,
   *  removing the rest. Stores of open windows are left alone. */
  sweep(kept: readonly string[]): Promise<void> {
    return (this.#swept = this.#sweep(new Set(kept.map(fileKey))))
  }

  async #sweep(named: ReadonlySet<string>): Promise<void> {
    await mkdir(this.#own, { recursive: true })
    const formats = dirname(this.root)
    for (const name of await readdir(formats).catch(() => []))
      if (name !== FORMAT) await removeFolder(join(formats, name))
    for (const name of await readdir(this.root).catch(() => [])) {
      const folder = join(this.root, name)
      const window = /^(?:\d+|[\da-f-]{36})$/.test(name) ? name : undefined
      if (folder === this.#own || (window !== undefined && (await alive(window)))) continue
      // A closed window's stores are moved, never copied, into this window's folder.
      if (window !== undefined)
        for (const store of await readdir(folder).catch(() => []))
          await rename(join(folder, store), join(this.#own, store)).catch(() => {})
      await removeFolder(folder)
    }
    const names = await readdir(this.#own).catch(() => [])
    const found = await Promise.all(
      names.map(async (name) => {
        const folder = join(this.#own, name)
        return { folder, manifest: await manifestOf(folder) }
      }),
    )
    const gone: string[] = []
    for (const { folder, manifest } of found) {
      const key = manifest && fileKey(manifest.path)
      if (!key || !named.has(key)) {
        gone.push(folder)
        continue
      }
      const latest = this.#latest.get(key)
      if (latest && BigInt(latest.manifest!.stamp.modified) >= BigInt(manifest.stamp.modified))
        gone.push(folder)
      else {
        if (latest) gone.push(latest.folder)
        this.#latest.set(key, new Store(folder, key, manifest, this))
      }
    }
    await Promise.all(gone.map(removeFolder))
  }

  #use(store: Store): Store {
    this.#using.set(store, (this.#using.get(store) ?? 0) + 1)
    return store
  }

  async create(path: string): Promise<Store> {
    await this.#swept
    const folder = join(this.#own, randomUUID())
    await mkdir(folder, { recursive: true })
    return this.#use(new Store(folder, fileKey(path), undefined, this))
  }

  /** The latest store still valid for the file's stamp `now` and the case `fingerprint`. A partial
   *  store goes to one reader at a time. */
  async find(path: string, now: Stamp, fingerprint: string): Promise<Store | undefined> {
    await this.#swept
    const store = this.#latest.get(fileKey(path))
    const manifest = store?.manifest
    if (
      !store ||
      !manifest ||
      (!same(manifest.stamp, now) &&
        (manifest.complete || manifest.stamp.file !== now.file || now.size < manifest.read)) ||
      manifest.fingerprint !== fingerprint ||
      (!manifest.complete && this.#using.has(store))
    )
      return undefined
    return this.#use(store)
  }

  async discard(store: Store): Promise<void> {
    if (this.#latest.get(store.key) === store) this.#latest.delete(store.key)
    await this.release(store)
  }

  /** Marks a committed store as its file's latest, and removes the one it replaces. */
  async finished(store: Store): Promise<void> {
    const before = this.#latest.get(store.key)
    this.#latest.set(store.key, store)
    if (before && before !== store && !this.#using.has(before)) await before.close(true)
  }

  /** Releases one reader. With none left the store closes, and is removed if uncommitted or
   *  superseded. */
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
