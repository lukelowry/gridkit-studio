/** The view's copy of the extension's clock, advanced locally each frame between updates. */

import type { TransportAction } from '../shared/messages.js'
import { advance, type ClockState, IDLE } from '../shared/transport.js'
import { bridge } from './bridge.js'

export interface Clock {
  readonly state: ClockState
  now(): number
  /** Moves the playhead here at once, and in other views once the extension relays it. */
  seek(t: number): void
  /** Any other transport action; it applies when the extension replies. */
  act(action: Exclude<TransportAction, { action: 'seek' }>): void
  stop(): void
}

/** Calls `paint` with the playhead whenever it moves, and `changed` when the clock state does. */
export function createClock(paint: (t: number) => void, changed: () => void = () => {}): Clock {
  let state: ClockState = IDLE
  /** `performance.now()` when `state` arrived. */
  let since = 0
  /** The sequence number of this view's latest action. It restarts at zero each generation, as the
   *  extension's count does, and replies echo it. */
  let seq = 0
  let generation = bridge.of.generation
  let seekFrame = 0
  let failed = false
  const draw = (t: number) => {
    try {
      paint(t)
      failed = false
    } catch (error) {
      if (!failed) bridge.report(error)
      failed = true
    }
  }
  const now = () => advance(state, performance.now() - since).t
  const apply = (next: ClockState) => {
    state = next
    since = performance.now()
    draw(next.t)
  }
  const off = bridge.on((message) => {
    if (message.kind === 'visible') return
    if (message.kind === 'state' && message.of.generation !== generation) {
      generation = message.of.generation
      seq = 0
    }
    // Ignore clocks of another generation, and replies to actions this view has since superseded.
    if (message.kind !== 'clock' || message.of.generation !== generation || message.seq < seq)
      return
    apply(message.clock)
    changed()
  })
  return {
    get state() {
      return state
    },
    now,
    seek(t) {
      if (state.status === 'idle') return
      apply({ ...state, t })
      seq++
      // At most one message per frame, with the latest playhead, in the envelope the seek was made
      // in: the extension drops it if that generation has passed.
      const from = bridge.of
      seekFrame ||= requestAnimationFrame(() => {
        seekFrame = 0
        bridge.send({ kind: 'transport', seq, action: 'seek', value: state.t }, from)
      })
    },
    act(action) {
      bridge.send({ kind: 'transport', seq: ++seq, ...action })
    },
    stop() {
      off()
      cancelAnimationFrame(seekFrame)
    },
  }
}
