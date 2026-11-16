/** Idle results files a worker keeps under one budget of `limit` bytes. Each stays until it is
 *  opened again, and past the limit the one idle longest is evicted first. */
export class ResultCache {
  /** Idle files, oldest first, with their size and eviction callback. */
  readonly #idle = new Map<object, { readonly bytes: number; readonly evicted: () => void }>()
  #bytes = 0
  #limit: number

  constructor(limit: number) {
    this.#limit = limit
  }

  get bytes(): number {
    return this.#bytes
  }

  /** Lowering the limit evicts what no longer fits right away. */
  set limit(bytes: number) {
    this.#limit = bytes
    this.#trim()
  }

  /** Keeps idle `file` as `bytes` of the budget until it is removed, or calls `evicted` when it no
   *  longer fits. */
  add(file: object, bytes: number, evicted: () => void): void {
    this.remove(file)
    if (bytes > this.#limit) return evicted()
    this.#idle.set(file, { bytes, evicted })
    this.#bytes += bytes
    this.#trim()
  }

  /** Removes `file` without evicting it, when it is opened again or closed. */
  remove(file: object): void {
    const entry = this.#idle.get(file)
    if (!entry) return
    this.#idle.delete(file)
    this.#bytes -= entry.bytes
  }

  #trim(): void {
    for (const [file, { evicted }] of this.#idle) {
      if (this.#bytes <= this.#limit) return
      this.remove(file)
      evicted()
    }
  }
}
