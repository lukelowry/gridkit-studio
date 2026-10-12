/** The frames of a results file, decoded once into files of Studio's own: what every read of them
 *  after reads, exactly, whatever has become of the CSV since. Chunk `k` of field `f` is one block,
 *  each of its rows a run of the chunk's frames, so a view reads only the rows it draws. A store
 *  read through says what it holds, so a window opened again reads the results from it rather than
 *  from the CSV. One store is kept of each results file a saved session names. */

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

import type { Domain } from '@latkit/model'

/** What a store holds: the results file it read, as that file was, and how its frames are cut. */
export interface Manifest {
  readonly format: typeof FORMAT
  /** The results file, and its size and time as it was read through. */
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
  /** The content of the case its header was matched against. */
  readonly fingerprint: string
  /** The CSV header's names, which say what the file holds of that case. */
  readonly header: readonly string[]
  readonly frames: number
  readonly chunk: number
  readonly domain: Domain
  readonly domains: Record<string, Record<string, Domain>>
}

/** The store's own format: a store written in another is read again from its CSV. */
const FORMAT = 1
const FRAMES = 'frames.bin'
const TIMES = 'times.bin'
const MANIFEST = 'manifest.json'
const BYTES = Float64Array.BYTES_PER_ELEMENT

/** `path` as its file system compares paths: on Windows and macOS, in any case alike. */
export function fileKey(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' || process.platform === 'darwin' ? full.toLowerCase() : full
}

/** Reads `bytes.length` bytes of `file` at `position` into `bytes`, all of them. */
async function readAll(file: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  for (let read = 0; read < bytes.length;) {
    const { bytesRead } = await file.read(bytes, read, bytes.length - read, position + read)
    if (!bytesRead) throw new Error('A results store ends before what it holds.')
    read += bytesRead
  }
}

/** The manifest of the store in `folder`, when it was read through in this format. */
async function manifestOf(folder: string): Promise<Manifest | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(folder, MANIFEST), 'utf8')) as Manifest
    return manifest.format === FORMAT ? manifest : undefined
  } catch {
    return undefined
  }
}

/** One results file's frames, kept as they are decoded. */
export class Store {
  #file?: Promise<FileHandle>
  /** How many rows each field holds, and where each field's rows start among all of them. */
  #rows: readonly number[] = []
  #starts: readonly number[] = []
  #width = 0
  #chunk = 0
  #manifest?: Manifest

  constructor(
    /** The folder it is kept in. */
    readonly folder: string,
    /** The results file, as its file system compares paths. */
    readonly key: string,
    manifest?: Manifest,
    /** The stores it is one of, which hear once it is read through. */
    private readonly owner?: Stores,
  ) {
    this.#manifest = manifest
  }

  /** What it holds, once read through. */
  get manifest(): Manifest | undefined {
    return this.#manifest
  }

  /** Cuts the frames as `rows`, each field's, and `chunk` frames a chunk say: the header's to say. */
  shape(rows: readonly number[], chunk: number): void {
    let at = 0
    this.#starts = rows.map((count) => (at += count) - count)
    this.#rows = rows
    this.#width = at
    this.#chunk = chunk
  }

  /** Where chunk `k` starts: past every whole chunk before it. */
  #at(k: number): number {
    return k * this.#chunk * this.#width * BYTES
  }

  #handle(): Promise<FileHandle> {
    return (this.#file ??= open(join(this.folder, FRAMES), this.#manifest ? 'r' : 'w+'))
  }

  /** Keeps chunk `k`: `count` frames of each field's `values`, frame by frame as they were read,
   *  written row by row. */
  async write(k: number, count: number, values: readonly Float64Array[]): Promise<void> {
    const block = new Float64Array(count * this.#width)
    let into = 0
    values.forEach((field, f) => {
      const rows = this.#rows[f]!
      for (let row = 0; row < rows; row++)
        for (let t = 0; t < count; t++) block[into++] = field[t * rows + row]!
    })
    const file = await this.#handle()
    const bytes = new Uint8Array(block.buffer)
    for (let written = 0; written < bytes.length;) {
      const { bytesWritten } = await file.write(
        bytes,
        written,
        bytes.length - written,
        this.#at(k) + written,
      )
      written += bytesWritten
    }
  }

  /** Field `f` of chunk `k`, of `count` frames, row by row: of the rows at `places` among the
   *  field's, ascending, when given, else of every one. One read per run of rows. */
  async read(k: number, f: number, count: number, places?: Uint32Array): Promise<Float64Array> {
    const file = await this.#handle()
    const base = this.#at(k) + count * this.#starts[f]! * BYTES
    const row = count * BYTES
    if (!places) {
      const values = new Float64Array(count * this.#rows[f]!)
      await readAll(file, new Uint8Array(values.buffer), base)
      return values
    }
    const values = new Float64Array(count * places.length)
    const bytes = new Uint8Array(values.buffer)
    for (let i = 0; i < places.length;) {
      let j = i + 1
      while (j < places.length && places[j] === places[j - 1]! + 1) j++
      await readAll(file, bytes.subarray(i * row, j * row), base + places[i]! * row)
      i = j
    }
    return values
  }

  /** Says what it holds, read through, with every frame's `times`: it reads alone from here on. */
  async finish(manifest: Omit<Manifest, 'format'>, times: Float64Array): Promise<void> {
    await writeFile(join(this.folder, TIMES), times)
    const written: Manifest = { format: FORMAT, ...manifest }
    // Written whole, then named, so a store says what it holds or nothing.
    const draft = join(this.folder, MANIFEST + '.draft')
    await writeFile(draft, JSON.stringify(written))
    await rename(draft, join(this.folder, MANIFEST))
    this.#manifest = written
    await this.owner?.finished(this)
  }

  /** Every frame's time, of a store read through. */
  async times(): Promise<Float64Array> {
    const times = new Float64Array(this.#manifest!.frames)
    const file = await open(join(this.folder, TIMES), 'r')
    try {
      await readAll(file, new Uint8Array(times.buffer), 0)
    } finally {
      await file.close()
    }
    return times
  }

  /** Lets go of its file, and with `remove` of the store itself. */
  async close(remove = false): Promise<void> {
    const file = this.#file
    this.#file = undefined
    await file?.then((handle) => handle.close()).catch(() => {})
    if (remove) await rm(this.folder, { recursive: true, force: true })
  }
}

/** The stores of the results files a worker reads, in one folder. */
export class Stores {
  /** The latest store read through of each results file, by its key. */
  readonly #latest = new Map<string, Store>()
  /** The stores of the results files read now, and how many read each. */
  readonly #using = new Map<Store, number>()
  /** The sweep the stores wait for before any is made or found. */
  #swept: Promise<void> = Promise.resolve()

  constructor(readonly root: string) {}

  /** Keeps the latest store read through of each results file `kept` names, and removes the rest:
   *  stores never read through, those of files no saved session names, and those a later store
   *  took the place of. Asked as the worker starts, before it reads anything. */
  sweep(kept: readonly string[]): Promise<void> {
    return (this.#swept = this.#sweep(new Set(kept.map(fileKey))))
  }

  async #sweep(named: ReadonlySet<string>): Promise<void> {
    const names = await readdir(this.root).catch(() => [])
    const found = await Promise.all(
      names.map(async (name) => {
        const folder = join(this.root, name)
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
      if (latest && latest.manifest!.mtimeMs >= manifest.mtimeMs) removed.push(folder)
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
    const folder = join(this.root, randomUUID())
    await mkdir(folder, { recursive: true })
    return this.#use(new Store(folder, fileKey(path), undefined, this))
  }

  /** The store read through of the results file at `path` as `stat` says it is now, matched
   *  against a case of `fingerprint`: the latest, when it read that same file. */
  async find(
    path: string,
    { size, mtimeMs }: { readonly size: number; readonly mtimeMs: number },
    fingerprint: string,
  ): Promise<Store | undefined> {
    await this.#swept
    const store = this.#latest.get(fileKey(path))
    const manifest = store?.manifest
    if (
      !store ||
      manifest?.size !== size ||
      manifest.mtimeMs !== mtimeMs ||
      manifest.fingerprint !== fingerprint
    )
      return undefined
    return this.#use(store)
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
