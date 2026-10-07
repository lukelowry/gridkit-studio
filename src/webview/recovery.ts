/** Coalesce failures and back off repeated restarts, without abandoning a recoverable view. */
export class Recovery {
  blocked = false
  #reported = ''
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
    const code = String((error as { code?: unknown } | null)?.code ?? '')
    if (
      ['aborted', 'cancelled', 'superseded', 'closed'].includes(code) ||
      (error as Error)?.name === 'AbortError'
    )
      return
    if (!['device-lost', 'timeout', 'unavailable'].includes(code)) {
      this.blocked = true
      const key = code + ':' + String((error as Error)?.message ?? error)
      if (key !== this.#reported) {
        this.#reported = key
        this.report(error)
      }
      return
    }
    this.blocked = false
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
    this.blocked = false
    const now = performance.now()
    this.#healthy ??= now
    if (now - this.#healthy >= 10_000) this.#attempt = 0
  }

  dispose(): void {
    this.#closed = true
    clearTimeout(this.#timer)
  }
}
