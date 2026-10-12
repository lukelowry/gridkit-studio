import type { Data } from '@latkit/model'

/** One batch per field, all over the same frames. */
export type Frames = readonly Data.SampleBatch[]

/** The bytes `frames` keep alive of their own: their times and values. The rows they name, and the
 *  table those number, are the file's, which every chunk shares. */
const ownBytes = (frames: Frames) =>
  frames.reduce(
    (bytes, batch) =>
      Object.values(batch.columns).reduce(
        (sum, column) => sum + column.values.byteLength,
        bytes + batch.coordinates.byteLength,
      ),
    0,
  )

/** A decoded chunk kept, the file it is of, and its key there. */
interface Entry {
  readonly owner: object
  readonly key: number
  readonly frames: Frames
  readonly bytes: number
}

/** Decoded chunks of every results file a worker reads, each by its file and a key of the file's
 *  own; past `limit` bytes in all, the least recently used are let go. */
export class ResultCache {
  /** Every entry, least recently used first. */
  readonly #order = new Set<Entry>()
  readonly #owners = new Map<object, Map<number, Entry>>()
  #bytes = 0
  #limit: number

  constructor(limit: number) {
    this.#limit = limit
  }

  /** The bytes kept. */
  get bytes(): number {
    return this.#bytes
  }

  get limit(): number {
    return this.#limit
  }

  /** A lower limit lets go at once of the least recently used past it. */
  set limit(bytes: number) {
    this.#limit = bytes
    this.#trim()
  }

  /** `owner`'s frames by `key`, now the most recently used. */
  get(owner: object, key: number): Frames | undefined {
    const entry = this.#owners.get(owner)?.get(key)
    if (!entry) return undefined
    this.#order.delete(entry)
    this.#order.add(entry)
    return entry.frames
  }

  /** Keeps `owner`'s `frames`, whose arrays nothing writes again, by `key`: unless they alone
   *  exceed the limit. */
  put(owner: object, key: number, frames: Frames): void {
    const bytes = ownBytes(frames)
    if (bytes > this.#limit) return
    // What it replaces goes first, and with it the owner's entries when it was their last.
    const old = this.#owners.get(owner)?.get(key)
    if (old) this.#forget(old)
    let entries = this.#owners.get(owner)
    if (!entries) this.#owners.set(owner, (entries = new Map()))
    const entry = { owner, key, frames, bytes }
    entries.set(key, entry)
    this.#order.add(entry)
    this.#bytes += bytes
    this.#trim()
  }

  /** Lets go of everything kept of `owner`. */
  drop(owner: object): void {
    for (const entry of this.#owners.get(owner)?.values() ?? []) this.#forget(entry)
  }

  #trim() {
    for (const entry of this.#order) {
      if (this.#bytes <= this.#limit) return
      this.#forget(entry)
    }
  }

  #forget(entry: Entry) {
    this.#order.delete(entry)
    this.#bytes -= entry.bytes
    const entries = this.#owners.get(entry.owner)!
    entries.delete(entry.key)
    if (!entries.size) this.#owners.delete(entry.owner)
  }
}
