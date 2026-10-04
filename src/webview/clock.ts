/** The case's clock as this view reads it. The extension holds the clock and tells every view when
 *  it changes; between changes each view integrates it here, a frame at a time, with no messages. */

import type { TransportAction } from '../messages.js'
import { advance, type ClockState, IDLE } from '../transport.js'
import { bridge } from './bridge.js'

export interface Clock {
  /** The clock as of its last change. */
  readonly state: ClockState
  /** Whether the run on show is still receiving frames. */
  readonly live: boolean
  /** The playhead now. */
  now(): number
  /** Move the playhead to `t`: here at once, and for every view once the extension has heard. */
  seek(t: number): void
  /** Change the clock some other way; the extension's answer is the change. */
  act(action: Exclude<TransportAction, { action: 'seek' }>): void
  stop(): void
}

/** The clock, calling `paint` with the playhead whenever it moves and `changed` when its state does. */
export function createClock(paint: (t: number) => void, changed: () => void = () => {}): Clock {
  let state: ClockState = IDLE
  let live = false
  /** This view's time when `state` was heard of. */
  let since = 0
  let frame = 0
  /** The newest change this view made, which the extension's answers are numbered by. */
  let seq = 0
  let sending = 0
  const now = () => advance(state, performance.now() - since).t
  const tick = () => {
    frame = 0
    if (state.status !== 'playing') return
    paint(now())
    frame = requestAnimationFrame(tick)
  }
  const set = (next: ClockState) => {
    state = next
    since = performance.now()
    paint(next.t)
    if (next.status === 'playing' && !frame) frame = requestAnimationFrame(tick)
  }
  const off = bridge.on((message) => {
    // An answer older than this view's newest change is an echo of one it has moved past.
    if (message.kind !== 'clock' || message.seq < seq) return
    live = message.live
    set(message.clock)
    changed()
  })
  return {
    get state() {
      return state
    },
    get live() {
      return live
    },
    now,
    seek(t) {
      if (state.status === 'idle') return
      set({ ...state, t })
      seq++
      // One message a frame, carrying wherever the playhead has reached by then.
      sending ||= requestAnimationFrame(() => {
        sending = 0
        bridge.send({ kind: 'transport', seq, action: 'seek', value: state.t })
      })
    },
    act(action) {
      bridge.send({ kind: 'transport', seq: ++seq, ...action })
    },
    stop() {
      off()
      cancelAnimationFrame(frame)
      cancelAnimationFrame(sending)
    },
  }
}
