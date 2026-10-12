import type { Data } from '@latkit/model'

/** One batch per field, all over the same frames. */
export type Frames = readonly Data.SampleBatch[]

/** The bytes `frames` keep alive of their own: their values. Their times are their file's, which
 *  every chunk of it shares, as are the rows they name. */
const ownBytes = (frames: Frames) =>
  frames.reduce(
    (bytes, batch) =>
      Object.values(batch.columns).reduce((sum, column) => sum + column.values.byteLength, bytes),
    0,
  )

/** The key of a file's own entry, which it rests under once nothing holds it. */
const RESTING = -1

/** Something kept: a decoded chunk of a file, by its key there, or a file resting. */
interface Entry {
  readonly owner: object
  readonly key: number
  readonly frames?: Frames
  readonly bytes: number
  /** What a file resting does once let go of. */
  readonly evicted?: () => void
}

/** What a worker keeps of the results files it reads under one budget of `limit` bytes: their
 *  decoded chunks, and the files nothing holds, which rest until they are opened again. Past the
 *  limit, what is cold goes first, least recently used first, then what is warm: a chunk is warm
 *  once a view reads it, so a file read through only passes through the cold. */
export class ResultCache {
  /** Each tier, least recently used first. */
  readonly #cold = new Set<Entry>()
  readonly #warm = new Set<Entry>()
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

  /** A lower limit lets go at once of what is past it. */
  set limit(bytes: number) {
    this.#limit = bytes
    this.#trim()
  }

  /** `owner`'s frames by `key`, now warm and the most recently used. */
  get(owner: object, key: number): Frames | undefined {
    const entry = this.#owners.get(owner)?.get(key)
    if (!entry) return undefined
    this.#cold.delete(entry)
    this.#warm.delete(entry)
    this.#warm.add(entry)
    return entry.frames
  }

  /** Keeps `owner`'s `frames`, whose arrays nothing writes again, by `key`: warm when a view reads
   *  them, else cold; unless they alone exceed the limit. */
  put(owner: object, key: number, frames: Frames, warm: boolean): void {
    this.#keep({ owner, key, frames, bytes: ownBytes(frames) }, warm)
  }

  /** Keeps `file`, which nothing holds, as `bytes` of the budget, until it is opened again; past
   *  the limit, it is let go of with `evicted`. */
  rest(file: object, bytes: number, evicted: () => void): void {
    this.#keep({ owner: file, key: RESTING, bytes, evicted }, false)
  }

  /** Takes `file` back from resting, as it is opened again. */
  wake(file: object): void {
    const entry = this.#owners.get(file)?.get(RESTING)
    if (entry) this.#forget(entry)
  }

  /** Lets go of everything kept of `owner`. */
  drop(owner: object): void {
    for (const entry of [...(this.#owners.get(owner)?.values() ?? [])]) this.#forget(entry)
  }

  #keep(entry: Entry, warm: boolean): void {
    // What it replaces goes first, and with it the owner's entries when it was their last.
    const old = this.#owners.get(entry.owner)?.get(entry.key)
    if (old) this.#forget(old)
    if (entry.bytes > this.#limit) return entry.evicted?.()
    let entries = this.#owners.get(entry.owner)
    if (!entries) this.#owners.set(entry.owner, (entries = new Map()))
    entries.set(entry.key, entry)
    ;(warm ? this.#warm : this.#cold).add(entry)
    this.#bytes += entry.bytes
    this.#trim()
  }

  #trim() {
    for (const tier of [this.#cold, this.#warm])
      for (const entry of tier) {
        if (this.#bytes <= this.#limit) return
        this.#forget(entry)
        entry.evicted?.()
      }
  }

  #forget(entry: Entry) {
    this.#cold.delete(entry)
    this.#warm.delete(entry)
    this.#bytes -= entry.bytes
    const entries = this.#owners.get(entry.owner)!
    entries.delete(entry.key)
    if (!entries.size) this.#owners.delete(entry.owner)
  }
}
