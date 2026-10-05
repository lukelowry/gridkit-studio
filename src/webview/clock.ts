/** The view's copy of the extension's clock, advanced locally each frame between updates. */

import type { TransportAction } from '../shared/messages.js'
import { advance, type ClockState, IDLE } from '../shared/transport.js'
import { bridge } from './bridge.js'

export interface Clock {
  /** The clock as of its last change. */
  readonly state: ClockState
  /** Whether the shown run is receiving frames. */
  readonly live: boolean
  /** The current playhead. */
  now(): number
  /** Moves the playhead here at once, and in every view once the extension relays it. */
  seek(t: number): void
  /** Any other transport action; it takes effect when the extension answers. */
  act(action: Exclude<TransportAction, { action: 'seek' }>): void
  stop(): void
}

/** Calls `paint` with the playhead whenever it moves, and `changed` when the clock state does. */
export function createClock(paint: (t: number) => void, changed: () => void = () => {}): Clock {
  let state: ClockState = IDLE
  let live = false
  /** `performance.now()` when `state` arrived. */
  let since = 0
  let frame = 0
  /** This view's latest action; the extension's answers carry it back. */
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
    // Skip answers to actions this view has since superseded.
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
      // One message per frame, carrying wherever the playhead has reached.
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
