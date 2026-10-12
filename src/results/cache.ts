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

/** Decoded chunks by key; past `limit` bytes, the least recently used are dropped. */
export class ResultCache {
  readonly #entries = new Map<string, { frames: Frames; bytes: number }>()
  bytes = 0
  #limit: number
  constructor(limit = 256 << 20) {
    this.#limit = limit
  }
  get limit(): number {
    return this.#limit
  }
  /** A lower limit lets go at once of the least recently used past it. */
  set limit(bytes: number) {
    this.#limit = bytes
    this.#trim()
  }
  get(key: string) {
    const found = this.#entries.get(key)
    if (found) {
      this.#entries.delete(key)
      this.#entries.set(key, found)
    }
    return found?.frames
  }
  /** Keeps `frames` themselves, whose arrays nothing writes again, unless they alone exceed the
   *  limit; returns them either way. */
  put(key: string, frames: Frames) {
    const bytes = ownBytes(frames)
    if (bytes > this.limit) return frames
    const old = this.#entries.get(key)
    if (old) this.bytes -= old.bytes
    this.#entries.delete(key)
    this.#entries.set(key, { frames, bytes })
    this.bytes += bytes
    this.#trim()
    return frames
  }
  #trim() {
    for (const [key, entry] of this.#entries) {
      if (this.bytes <= this.#limit) return
      this.#entries.delete(key)
      this.bytes -= entry.bytes
    }
  }
  drop(prefix: string) {
    for (const [key, entry] of this.#entries)
      if (key.startsWith(prefix)) {
        this.#entries.delete(key)
        this.bytes -= entry.bytes
      }
  }
}
