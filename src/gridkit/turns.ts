/** Long work a worker does in turns, so its other requests are answered meanwhile. */

import { setImmediate } from 'node:timers/promises'

import { interruptible } from '@latkit/model'

/** How long a turn runs before the worker answers what else it was asked. */
const TURN_MS = 8

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
    return interruptible(task, this.signal)
  }
}
