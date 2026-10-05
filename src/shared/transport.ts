/** What a playhead does at the ends of its span. */
export type LoopMode = 'none' | 'wrap' | 'pingpong'

/** The clock as of its last change. */
export interface ClockState {
  /** Increments with every new span, so readers can tell spans apart. */
  readonly epoch: number
  readonly status: 'idle' | 'playing' | 'paused'
  /** The playhead at the last change. */
  readonly t: number
  /** Simulated seconds per wall-clock second. */
  readonly rate: number
  readonly loop: LoopMode
  /** Flipped at each end by a pingpong loop. */
  readonly direction: 1 | -1
  readonly span: readonly [number, number]
  /** Whether the playhead follows the head of a result that is arriving. */
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

/** Where a time lands in the span, the direction it then moves, and whether a play-once playhead
 *  ran past an end. */
interface Folded {
  readonly t: number
  readonly direction: 1 | -1
  readonly ended: boolean
}

export function clamp(t: number, [start, end]: readonly [number, number]): number {
  return Math.max(start, Math.min(end, t))
}

/** Folds an unbounded time into the span by `loop`. The start is not an end: a playhead moving
 *  forward from it keeps playing. */
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

/** The playhead `elapsed` milliseconds after `state` was set; a clock not playing holds its place. */
export function advance(state: ClockState, elapsed: number): Folded {
  if (state.status !== 'playing')
    return { t: clamp(state.t, state.span), direction: state.direction, ended: false }
  const t = state.t + (elapsed / 1000) * state.rate * state.direction
  return fold(t, state.span, state.loop, state.direction)
}

interface SpanOptions {
  /** Whether frames are arriving, so the playhead follows the head. */
  readonly live?: boolean
  /** How near the head a seek counts as at the head: about one frame. */
  readonly headTolerance?: number
}

/** How long past the computed end the end timer fires, so it never lands short of the edge. */
const SLACK_MS = 50

/** The playback clock: seeking, loops, and following a live head. Between changes, readers compute
 *  the playhead with `advance`. */
export class Transport {
  #state: ClockState = IDLE
  /** Wall-clock milliseconds at the last change. */
  #since = 0
  #live = false
  /** Where the result's head was last seen. */
  #head = 0
  #tolerance = Number.EPSILON
  #alarm: ReturnType<typeof setTimeout> | null = null

  /** Reports every change to `changed`; `now` reads the wall clock in milliseconds. */
  constructor(
    private readonly changed: (state: ClockState) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get state(): ClockState {
    return this.#state
  }

  /** Whether frames are arriving. */
  get live(): boolean {
    return this.#live
  }

  /** The current playhead, without changing the state. */
  currentT(): number {
    return advance(this.#state, this.now() - this.#since).t
  }

  /** The clock settled at this instant, for a reader that integrates from when it receives it. */
  snapshot(): ClockState {
    const { t, direction } = advance(this.#state, this.now() - this.#since)
    return { ...this.#state, t, direction }
  }

  /** Drops the span: idle at the origin, in a new epoch. */
  clear(): void {
    this.#live = false
    this.#head = 0
    this.#commit({ ...IDLE, epoch: this.#state.epoch + 1 })
  }

  /** Starts `span` in a new epoch: paused at its start, rate 1, no loop, following when live. */
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

  /** Widens the span to `end` as frames arrive past it; the playhead stays where it is. */
  extend(end: number): void {
    const [start, last] = this.#state.span
    if (this.#state.status === 'idle' || !(end > last)) return
    this.#settle()
    this.#commit({ ...this.#state, span: [start, end] })
  }

  /** Records the head at `t`. A following playhead moves with it, unreported, and returns true: the
   *  data that moved the head is the news. */
  noteHead(t: number): boolean {
    this.#head = t
    if (!this.#state.follow) return false
    this.#state = { ...this.#state, t: clamp(t, this.#state.span) }
    this.#since = this.now()
    return true
  }

  /** When frames stop arriving, a following playhead stays where the head stopped. */
  setLive(live: boolean): void {
    if (this.#live === live) return
    this.#live = live
    if (live || !this.#state.follow) return
    this.#settle()
    this.#commit({ ...this.#state, follow: false, t: clamp(this.#head, this.#state.span) })
  }

  /** Behind a live head, a seek stops following; at the head, it follows again. */
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

  /** Plays from the start again when a play-once span has finished; stops following. */
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

  pause(): void {
    if (this.#state.status !== 'playing') return
    this.#settle()
    // Settling may have paused at the end already.
    if (this.#state.status === 'playing') this.#commit({ ...this.#state, status: 'paused' })
  }

  playPause(): void {
    if (this.#state.status === 'playing') this.pause()
    else this.play()
  }

  /** Jumps to the head and follows it. */
  goLive(): void {
    if (!this.#live || this.#state.status === 'idle') return
    this.#commit({
      ...this.#state,
      t: clamp(this.#head, this.#state.span),
      status: 'paused',
      follow: true,
    })
  }

  /** Ignores a rate that is not positive. */
  setRate(rate: number): void {
    if (this.#state.status === 'idle' || !(rate > 0)) return
    this.#settle()
    this.#commit({ ...this.#state, rate })
  }

  /** Any loop but pingpong plays forward. */
  setLoop(loop: LoopMode): void {
    if (this.#state.status === 'idle') return
    this.#settle()
    const direction = loop === 'pingpong' ? this.#state.direction : 1
    this.#commit({ ...this.#state, loop, direction })
  }

  /** Stops the end timer. */
  dispose(): void {
    this.#disarm()
  }

  /** Folds the time played into the state, so the next change starts from this instant. */
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

  /** While a span plays once, wakes at its edge to pause, so readers that never poll see it; the
   *  edge is forced, so timer drift cannot matter. */
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
