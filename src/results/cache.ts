import { blockByteLength, type SampleBatch } from '@latkit/model'

/** One batch per field, all over the same frames. */
export type Frames = readonly SampleBatch[]

/** Decoded chunks by key; past `limit` bytes, the least recently used are dropped. */
export class ResultCache {
  readonly #entries = new Map<string, { frames: Frames; bytes: number }>()
  bytes = 0
  constructor(public limit = 256 << 20) {}
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
    const bytes = blockByteLength(frames)
    if (bytes > this.limit) return frames
    const old = this.#entries.get(key)
    if (old) this.bytes -= old.bytes
    this.#entries.delete(key)
    this.#entries.set(key, { frames, bytes })
    this.bytes += bytes
    while (this.bytes > this.limit) {
      const [key, entry] = this.#entries.entries().next().value!
      this.#entries.delete(key)
      this.bytes -= entry.bytes
    }
    return frames
  }
  drop(prefix: string) {
    for (const [key, entry] of this.#entries)
      if (key.startsWith(prefix)) {
        this.#entries.delete(key)
        this.bytes -= entry.bytes
      }
  }
}
