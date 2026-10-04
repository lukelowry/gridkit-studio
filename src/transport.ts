/** Playback state machine with seeking, loops, and live-head following; from Lattice.
 * Between state changes, readers integrate t(now) = fold(t0 + elapsed * rate * direction). */

/** What a playhead does at the ends of its span. */
export type LoopMode = 'none' | 'wrap' | 'pingpong'

/** The clock as of its last change. */
export interface ClockState {
  /** Grows with every new span, so a reader can tell spans apart. */
  readonly epoch: number
  readonly status: 'idle' | 'playing' | 'paused'
  /** The playhead at the moment of the last change. */
  readonly t: number
  /** Simulated seconds per wall-clock second. */
  readonly rate: number
  readonly loop: LoopMode
  /** Bouncing flips it at the ends. */
  readonly direction: 1 | -1
  readonly span: readonly [number, number]
  /** Whether the playhead follows the head of a result still arriving. */
  readonly follow: boolean
}

/** The clock before any result: idle at the origin of an empty span. */
export const IDLE: ClockState = {
  epoch: 0,
  status: 'idle',
  t: 0,
  rate: 1,
  loop: 'none',
  direction: 1,
  span: [0, 0],
  follow: false,
}

/** A time folded into the span by the loop mode: where it lands, the direction it then moves, and
 *  whether a playhead that plays once ran past an end. */
interface Folded {
  readonly t: number
  readonly direction: 1 | -1
  readonly ended: boolean
}

/** Keep `t` within the span. */
export function clamp(t: number, [start, end]: readonly [number, number]): number {
  return Math.max(start, Math.min(end, t))
}

/** Fold an unbounded time into the span. The start is not an end: a playhead moving forward from it
 *  keeps playing. */
export function fold(
  t: number,
  span: readonly [number, number],
  loop: LoopMode,
  direction: 1 | -1,
): Folded {
  const [start, end] = span
  const width = end - start
  if (!(width > 0)) return { t: start, direction, ended: loop === 'none' }
  if (loop === 'wrap') {
    const into = (((t - start) % width) + width) % width
    return { t: start + into, direction, ended: false }
  }
  if (loop === 'pingpong') {
    const phase = (((t - start) % (2 * width)) + 2 * width) % (2 * width)
    return phase <= width
      ? { t: start + phase, direction, ended: false }
      : { t: end - (phase - width), direction: direction === 1 ? -1 : 1, ended: false }
  }
  if (t >= end) return { t: end, direction, ended: t > end || direction === 1 }
  if (t <= start) return { t: start, direction, ended: t < start }
  return { t, direction, ended: false }
}

/** The playhead `elapsed` milliseconds after `state` was set; a clock not playing holds still. */
export function advance(state: ClockState, elapsed: number): Folded {
  if (state.status !== 'playing')
    return { t: clamp(state.t, state.span), direction: state.direction, ended: false }
  const t = state.t + (elapsed / 1000) * state.rate * state.direction
  return fold(t, state.span, state.loop, state.direction)
}

/** How a span is taken on. */
interface SpanOptions {
  /** Whether frames are still arriving, so the playhead follows the head. @defaultValue false */
  readonly live?: boolean
  /** How near the head a seek counts as at the head: about one frame. */
  readonly headTolerance?: number
}

/** A timer past the computed end, so the clamp at the edge is never ambiguous. */
const SLACK_MS = 50

export class Transport {
  #state: ClockState = IDLE
  /** Wall-clock milliseconds at the last change. */
  #since = 0
  #live = false
  /** Where the result's head was last seen. */
  #head = 0
  #tolerance = Number.EPSILON
  #alarm: ReturnType<typeof setTimeout> | null = null

  /** Report every change to `changed`; `now` reads the wall clock, in milliseconds. */
  constructor(
    private readonly changed: (state: ClockState) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** The clock as of its last change. */
  get state(): ClockState {
    return this.#state
  }

  /** Whether frames are still arriving. */
  get live(): boolean {
    return this.#live
  }

  /** The playhead now, without changing the state. */
  currentT(): number {
    return advance(this.#state, this.now() - this.#since).t
  }

  /** The clock settled at this instant, for a reader that starts integrating when it hears of it. */
  snapshot(): ClockState {
    const { t, direction } = advance(this.#state, this.now() - this.#since)
    return { ...this.#state, t, direction }
  }

  /** Drop the span: idle at the origin, in a new epoch. */
  clear(): void {
    this.#live = false
    this.#head = 0
    this.#commit({ ...IDLE, epoch: this.#state.epoch + 1 })
  }

  /** Take on `span` in a new epoch: paused at its start, real time, played once, following when live. */
  setSpan(
    span: readonly [number, number],
    { live = false, headTolerance = Number.EPSILON }: SpanOptions = {},
  ): void {
    this.#live = live
    this.#tolerance = headTolerance
    this.#head = span[0]
    this.#commit({
      epoch: this.#state.epoch + 1,
      status: 'paused',
      t: span[0],
      rate: 1,
      loop: 'none',
      direction: 1,
      span: [span[0], span[1]],
      follow: live,
    })
  }

  /** Frames arrived past the span's end: the span reaches `end` now, and the playhead stays where it
   *  was (or with the head, while following). */
  extend(end: number): void {
    const [start, last] = this.#state.span
    if (this.#state.status === 'idle' || !(end > last)) return
    this.#settle()
    this.#commit({ ...this.#state, span: [start, end] })
  }

  /** The head moved to `t`. A following playhead moves with it and true says so: the data that moved
   *  the head is the news, so no change is reported. */
  noteHead(t: number): boolean {
    this.#head = t
    if (!this.#state.follow) return false
    this.#state = { ...this.#state, t: clamp(t, this.#state.span) }
    this.#since = this.now()
    return true
  }

  /** Frames stopped (or started again) arriving; a following playhead stays where the head stopped. */
  setLive(live: boolean): void {
    if (this.#live === live) return
    this.#live = live
    if (live || !this.#state.follow) return
    this.#settle()
    this.#commit({ ...this.#state, follow: false, t: clamp(this.#head, this.#state.span) })
  }

  /** Move the playhead to `t`. Behind a live head it stops following; at or past the head it follows
   *  again. */
  seek(t: number): void {
    if (this.#state.status === 'idle') return
    const target = clamp(t, this.#state.span)
    const follow = this.#live && target >= this.#head - this.#tolerance
    this.#commit({
      ...this.#state,
      t: follow ? clamp(this.#head, this.#state.span) : target,
      status: follow ? 'paused' : this.#state.status,
      follow,
    })
  }

  /** Play from the playhead, from the start again when a finished span plays once; stops following. */
  play(): void {
    if (this.#state.status !== 'paused') return
    const [start, end] = this.#state.span
    if (!(end > start)) return
    const again = !this.#live && this.#state.loop === 'none' && this.#state.t >= end
    this.#commit({
      ...this.#state,
      t: again ? start : this.#state.t,
      status: 'playing',
      follow: false,
    })
  }

  /** Hold where the playhead is. */
  pause(): void {
    if (this.#state.status !== 'playing') return
    this.#settle()
    // Settling may have reached the end and paused there already.
    if (this.#state.status === 'playing') this.#commit({ ...this.#state, status: 'paused' })
  }

  /** Play when paused, pause when playing. */
  playPause(): void {
    if (this.#state.status === 'playing') this.pause()
    else this.play()
  }

  /** Jump to the newest frame and follow the head from there. */
  goLive(): void {
    if (!this.#live || this.#state.status === 'idle') return
    this.#commit({
      ...this.#state,
      t: clamp(this.#head, this.#state.span),
      status: 'paused',
      follow: true,
    })
  }

  /** Simulated seconds per wall-clock second; ignored unless positive. */
  setRate(rate: number): void {
    if (this.#state.status === 'idle' || !(rate > 0)) return
    this.#settle()
    this.#commit({ ...this.#state, rate })
  }

  /** What the playhead does at the ends; only bouncing plays backward. */
  setLoop(loop: LoopMode): void {
    if (this.#state.status === 'idle') return
    this.#settle()
    const direction = loop === 'pingpong' ? this.#state.direction : 1
    this.#commit({ ...this.#state, loop, direction })
  }

  /** Stop the end-of-span timer. */
  dispose(): void {
    this.#disarm()
  }

  /** Fold the time played so far into the state, so the next change starts from now. */
  #settle(): void {
    if (this.#state.status !== 'playing') return
    const played = advance(this.#state, this.now() - this.#since)
    if (played.ended) {
      this.#commit({ ...this.#state, status: 'paused', t: played.t, direction: played.direction })
      return
    }
    this.#state = { ...this.#state, t: played.t, direction: played.direction }
    this.#since = this.now()
  }

  #commit(next: ClockState): void {
    this.#state = next
    this.#since = this.now()
    this.#arm()
    this.changed(next)
  }

  /** While a span plays once, wake at its edge so every reader sees the pause, even one that never
   *  reads the clock; the edge is forced, so timer drift cannot matter. */
  #arm(): void {
    this.#disarm()
    const { status, loop, span, t, rate, direction } = this.#state
    if (status !== 'playing' || loop !== 'none') return
    const left = direction === 1 ? span[1] - t : t - span[0]
    this.#alarm = setTimeout(
      () => {
        this.#alarm = null
        this.#settle()
        if (this.#state.status !== 'playing') return
        const edge = this.#state.direction === 1 ? this.#state.span[1] : this.#state.span[0]
        const { t, direction } = fold(edge, this.#state.span, 'none', this.#state.direction)
        this.#commit({ ...this.#state, status: 'paused', t, direction })
      },
      Math.max(SLACK_MS, (left / rate) * 1000 + SLACK_MS),
    )
  }

  #disarm(): void {
    if (this.#alarm !== null) clearTimeout(this.#alarm)
    this.#alarm = null
  }
}
