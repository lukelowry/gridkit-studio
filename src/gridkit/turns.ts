/** Splits long worker tasks into turns so other requests are answered in between. */

import { setImmediate } from '../platform/timing.js'

/** How long a turn runs before the worker handles other requests. */
const TURN_MS = 8

/** A mask: a walk over records checks whether to yield every STEP_RECORDS + 1 records. */
export const STEP_RECORDS = 1023

/** Foreground requests in progress. Background work pauses while there are any. */
let awaited = 0
/** Resolves once no foreground request is in progress, releasing paused background work. */
let resumed: Promise<void> | undefined
let resume: (() => void) | undefined

/** Runs `task` as foreground work. Background work pauses between turns until it finishes. */
export async function awaitedWork<T>(task: () => Promise<T>): Promise<T> {
  awaited++
  try {
    return await task()
  } finally {
    if (--awaited === 0) {
      resume?.()
      resumed = resume = undefined
    }
  }
}

/** Long work split into turns of TURN_MS that stops when `signal` aborts. A turn ends with
 *  `setImmediate`, not a timer, since timers wait for the clock tick (about 15 ms on Windows).
 *  `background` work, such as diagnostics, pauses between turns while foreground work runs. */
export class Turns {
  #ends = performance.now() + TURN_MS

  constructor(
    readonly signal: AbortSignal = AbortSignal.any([]),
    readonly background = false,
  ) {}

  /** Yields once the turn's time is up. Throws when the signal has aborted. */
  async step(): Promise<void> {
    this.signal.throwIfAborted()
    if (performance.now() < this.#ends) return
    await setImmediate()
    while (this.background && awaited > 0)
      await this.wait((resumed ??= new Promise<void>((settle) => (resume = settle))))
    this.signal.throwIfAborted()
    this.#ends = performance.now() + TURN_MS
  }

  /** Awaits `task`, rejecting if the signal aborts first. */
  wait<T>(task: PromiseLike<T>): Promise<T> {
    const { signal } = this
    signal.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
      Promise.resolve(task).then(
        (value) => {
          signal.removeEventListener('abort', aborted)
          if (signal.aborted) reject(signal.reason)
          else resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', aborted)
          reject(error)
        },
      )
    })
  }
}
