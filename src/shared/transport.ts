/** The clock as of its last change. */
export interface ClockState {
  /** Increments with every new span, so readers can tell spans apart. */
  readonly epoch: number
  readonly status: 'idle' | 'playing' | 'paused'
  readonly t: number
  /** Simulated seconds per wall-clock second. */
  readonly rate: number
  readonly span: readonly [number, number]
  /** Whether the playhead follows the head of a result that is arriving. */
  readonly follow: boolean
}

export const IDLE: ClockState = {
  epoch: 0,
  status: 'idle',
  t: 0,
  rate: 1,
  span: [0, 0],
  follow: false,
}

/** The speeds a playhead plays at, in simulated seconds per second. */
export const RATES = [0.25, 0.5, 1, 2, 4] as const

interface Played {
  readonly t: number
  readonly ended: boolean
}

export function clamp(t: number, [start, end]: readonly [number, number]): number {
  return Math.max(start, Math.min(end, t))
}

/** The playhead `elapsed` milliseconds after `state` was set, stopping at the span's end. */
export function advance(state: ClockState, elapsed: number): Played {
  if (state.status !== 'playing') return { t: clamp(state.t, state.span), ended: false }
  const [start, end] = state.span
  const t = state.t + (elapsed / 1000) * state.rate
  return t >= end ? { t: end, ended: true } : { t: Math.max(start, t), ended: false }
}

interface SpanOptions {
  readonly live?: boolean
}

/** Extra delay on the end timer so it never fires short of the end. */
const SLACK_MS = 50
/** The longest delay setTimeout supports; longer ones fire immediately. */
const LONGEST_WAIT_MS = 2 ** 31 - 1

/** The playback clock: seeking, playing to the end, and following a live head. Between changes,
 *  readers compute the playhead with `advance`. */
export class Transport {
  #state: ClockState = IDLE
  /** Wall-clock milliseconds at the last change. */
  #since = 0
  #live = false
  /** Where the result's head was last seen. */
  #head = 0
  #alarm: ReturnType<typeof setTimeout> | null = null

  /** Reports every change to `changed`; `now` reads the wall clock in milliseconds. */
  constructor(
    private readonly changed: (state: ClockState) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get state(): ClockState {
    return this.#state
  }

  get live(): boolean {
    return this.#live
  }

  currentT(): number {
    return advance(this.#state, this.now() - this.#since).t
  }

  /** The clock at this instant, for a reader that advances it from when it receives it. */
  snapshot(): ClockState {
    return { ...this.#state, t: this.currentT() }
  }

  clear(): void {
    this.#live = false
    this.#head = 0
    this.#commit({ ...IDLE, epoch: this.#state.epoch + 1 })
  }

  /** Starts `span` in a new epoch, paused at its start, following the head when live. */
  setSpan(span: readonly [number, number], { live = false }: SpanOptions = {}): void {
    this.#live = live
    this.#head = span[0]
    this.#commit({
      epoch: this.#state.epoch + 1,
      status: 'paused',
      t: span[0],
      rate: this.#state.rate,
      span: [span[0], span[1]],
      follow: live,
    })
  }

  /** Widens the span to `end` and moves a following playhead there, in one change. */
  grow(end: number): void {
    if (this.#state.status === 'idle') return
    this.#head = end
    const [start, last] = this.#state.span
    const widened = end > last
    if (!widened && !this.#state.follow) return
    this.#settle()
    const span: [number, number] = widened ? [start, end] : [start, last]
    this.#commit({ ...this.#state, span, ...(this.#state.follow && { t: clamp(end, span) }) })
  }

  /** When frames stop arriving, a following playhead stays where the head stopped. */
  setLive(live: boolean): void {
    if (this.#live === live) return
    this.#live = live
    if (live || !this.#state.follow) return
    this.#settle()
    this.#commit({ ...this.#state, follow: false, t: clamp(this.#head, this.#state.span) })
  }

  /** Seeking behind a live head stops following; seeking to the head follows again. */
  seek(t: number): void {
    if (this.#state.status === 'idle' || !Number.isFinite(t)) return
    const target = clamp(t, this.#state.span)
    const follow = this.#live && target >= this.#head - Number.EPSILON
    this.#commit({
      ...this.#state,
      t: follow ? clamp(this.#head, this.#state.span) : target,
      status: follow ? 'paused' : this.#state.status,
      follow,
    })
  }

  /** Plays, restarting from the start if a finished span is no longer live; stops following. */
  play(): void {
    if (this.#state.status !== 'paused') return
    const [start, end] = this.#state.span
    if (!(end > start)) return
    const again = !this.#live && this.#state.t >= end
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

  goLive(): void {
    if (!this.#live || this.#state.status === 'idle') return
    this.#commit({
      ...this.#state,
      t: clamp(this.#head, this.#state.span),
      status: 'paused',
      follow: true,
    })
  }

  setRate(rate: number): void {
    if (this.#state.status === 'idle' || !(rate > 0 && Number.isFinite(rate))) return
    this.#settle()
    this.#commit({ ...this.#state, rate })
  }

  dispose(): void {
    this.#disarm()
  }

  /** Folds the time played into the state, so the next change starts from this instant. */
  #settle(): void {
    if (this.#state.status !== 'playing') return
    const played = advance(this.#state, this.now() - this.#since)
    if (played.ended) {
      this.#commit({ ...this.#state, status: 'paused', t: played.t })
      return
    }
    this.#state = { ...this.#state, t: played.t }
    this.#since = this.now()
  }

  #commit(next: ClockState): void {
    this.#state = next
    this.#since = this.now()
    this.#arm()
    this.changed(next)
  }

  /** While playing, pauses at the span's end so readers that never poll see it. The end time is
   *  set explicitly, so timer drift does not matter. */
  #arm(): void {
    this.#disarm()
    const { status, span, t, rate } = this.#state
    if (status !== 'playing') return
    const wait = Math.max(SLACK_MS, ((span[1] - t) / rate) * 1000 + SLACK_MS)
    this.#alarm = setTimeout(
      () => {
        this.#alarm = null
        this.#settle()
        if (this.#state.status !== 'playing') return
        // A wait longer than setTimeout supports fires early and re-arms.
        if (wait > LONGEST_WAIT_MS) return this.#arm()
        this.#commit({ ...this.#state, status: 'paused', t: this.#state.span[1] })
      },
      Math.min(wait, LONGEST_WAIT_MS),
    )
  }

  #disarm(): void {
    if (this.#alarm !== null) clearTimeout(this.#alarm)
    this.#alarm = null
  }
}
