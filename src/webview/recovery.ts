/** Coalesce failures and back off repeated restarts, without abandoning a recoverable view. */
export class Recovery {
  #timer?: ReturnType<typeof setTimeout>
  #attempt = 0
  #healthy?: number
  #closed = false

  constructor(
    private readonly restart: () => void,
    private readonly report: (error: unknown) => void,
  ) {}

  fail(error: unknown): void {
    if (this.#closed || this.#timer !== undefined) return
    this.#healthy = undefined
    if (!this.#attempt) this.report(error)
    const delay = Math.min(10_000, 250 * 2 ** Math.min(this.#attempt++, 6))
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      if (!this.#closed) this.restart()
    }, delay)
  }

  /** A single successful frame does not erase a repeated-failure backoff. */
  presented(): void {
    const now = performance.now()
    this.#healthy ??= now
    if (now - this.#healthy >= 10_000) this.#attempt = 0
  }

  dispose(): void {
    this.#closed = true
    clearTimeout(this.#timer)
  }
}
