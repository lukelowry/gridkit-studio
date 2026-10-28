/** Long work a worker does in turns, so its other requests are answered meanwhile. */

import { setImmediate } from 'node:timers/promises'

/** How long a turn runs before the worker answers what else it was asked. */
const TURN_MS = 8

/** How many records a long walk through a case reads between asking whether to yield, less one. */
export const STEP_RECORDS = 1023

/** Long work done in turns of TURN_MS, which stops once `signal` lets go. Each turn ends with
 *  `setImmediate`, never a timer: a timer waits for the system clock's next tick, which is about
 *  15 ms on Windows, so a loop of many turns would wait more than it works. */
export class Turns {
  #ends = performance.now() + TURN_MS

  constructor(readonly signal: AbortSignal = AbortSignal.any([])) {}

  /** Ends the turn once it has run its time, and stops once the signal lets go. */
  async step(): Promise<void> {
    this.signal.throwIfAborted()
    if (performance.now() < this.#ends) return
    await setImmediate()
    this.signal.throwIfAborted()
    this.#ends = performance.now() + TURN_MS
  }

  /** `task`, unless the signal lets go first. */
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
