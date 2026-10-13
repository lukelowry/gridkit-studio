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
  /** This view's latest action in the showing it counts them in, which the extension counts alike
   *  from naught as the view shows anew; its answers carry it back. */
  let seq = 0
  let counted = bridge.of.showing
  /** The seek to send at the next frame, of the showing it was made in. */
  let sending = 0
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
  const tick = () => {
    frame = 0
    if (state.status !== 'playing') return
    draw(now())
    frame = requestAnimationFrame(tick)
  }
  const set = (next: ClockState) => {
    state = next
    since = performance.now()
    draw(next.t)
    if (next.status === 'playing' && !frame) frame = requestAnimationFrame(tick)
  }
  const off = bridge.on((message) => {
    if (message.kind === 'shown') return
    // A showing begins with its state, and counts its changes to the clock from naught.
    if (message.kind === 'state' && message.of.showing !== counted) {
      counted = message.of.showing
      seq = 0
    }
    // Skip a clock of another showing, and answers to actions this view has since superseded.
    if (message.kind !== 'clock' || message.of.showing !== counted || message.seq < seq) return
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
      // One message per frame, carrying wherever the playhead has reached, of the showing the seek
      // was made in: a showing past drops it.
      const from = bridge.of
      sending ||= requestAnimationFrame(() => {
        sending = 0
        bridge.send({ kind: 'transport', seq, action: 'seek', value: state.t }, from)
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
