/** What a worker keeps of the results files nothing holds, under one budget of `limit` bytes: each
 *  rests until it is opened again, and past the limit the one resting longest goes first. */
export class ResultCache {
  /** Each file resting, longest first, and what letting go of it does. */
  readonly #resting = new Map<object, { readonly bytes: number; readonly evicted: () => void }>()
  #bytes = 0
  #limit: number

  constructor(limit: number) {
    this.#limit = limit
  }

  /** The bytes kept. */
  get bytes(): number {
    return this.#bytes
  }

  /** A lower limit lets go at once of what is past it. */
  set limit(bytes: number) {
    this.#limit = bytes
    this.#trim()
  }

  /** Keeps `file`, which nothing holds, as `bytes` of the budget, until it is opened again; past
   *  the limit, it is let go of with `evicted`. */
  rest(file: object, bytes: number, evicted: () => void): void {
    this.wake(file)
    if (bytes > this.#limit) return evicted()
    this.#resting.set(file, { bytes, evicted })
    this.#bytes += bytes
    this.#trim()
  }

  /** Takes `file` back from resting, as it is opened again or closed. */
  wake(file: object): void {
    const entry = this.#resting.get(file)
    if (!entry) return
    this.#resting.delete(file)
    this.#bytes -= entry.bytes
  }

  #trim(): void {
    for (const [file, { evicted }] of this.#resting) {
      if (this.#bytes <= this.#limit) return
      this.wake(file)
      evicted()
    }
  }
}
