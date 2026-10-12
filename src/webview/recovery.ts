import { passing, quiet } from '../shared/errors.js'

/** The longest a restart waits, and the first wait, which doubles with each failure in a row. */
const LONGEST_MS = 10_000
const FIRST_MS = 250
/** How long a view must work before a failure counts as the first again. */
const HEALTHY_MS = 10_000

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

  /** Whether a restart waits out its backoff: until it comes, nothing else restarts the view. */
  get pending(): boolean {
    return this.#timer !== undefined
  }

  fail(error: unknown): void {
    if (this.#closed || this.#timer !== undefined || quiet(error)) return
    if (!passing(error)) {
      this.blocked = true
      const key =
        String((error as { code?: unknown } | null)?.code ?? '') +
        ':' +
        String((error as Error)?.message ?? error)
      if (key !== this.#reported) {
        this.#reported = key
        this.report(error)
      }
      return
    }
    this.blocked = false
    this.#healthy = undefined
    if (!this.#attempt) this.report(error)
    const delay = Math.min(LONGEST_MS, FIRST_MS * 2 ** this.#attempt++)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      if (!this.#closed) this.restart()
    }, delay)
  }

  /** The view starts over, as the user reloads it: a failure it said is said again should it
   *  recur, and restarts back off from the first. */
  reset(): void {
    clearTimeout(this.#timer)
    this.#timer = this.#healthy = undefined
    this.#reported = ''
    this.#attempt = 0
    this.blocked = false
  }

  /** A single successful frame does not erase a repeated-failure backoff. */
  presented(): void {
    this.blocked = false
    const now = performance.now()
    this.#healthy ??= now
    if (now - this.#healthy >= HEALTHY_MS) this.#attempt = 0
  }

  dispose(): void {
    this.#closed = true
    clearTimeout(this.#timer)
  }
}
