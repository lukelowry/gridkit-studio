export interface TimeSource {
  info?: { rows: number; range: readonly [number, number] | null }
  locate(time: number, signal?: AbortSignal): Promise<number>
  timeAt(frame: number, signal?: AbortSignal): Promise<number>
}
export interface TimeState {
  time: number
  playing: boolean
  speed: number
  loop: boolean
  follow: boolean
  range: readonly [number, number] | null
}
/** One time position per case. Frame identity preserves equal-time event samples. */
export class Timeline {
  time = 0
  frame: number | undefined
  range: readonly [number, number] | null = null
  playing = false
  speed = 1
  loop = false
  follow = false
  private timer?: ReturnType<typeof setInterval>
  private last = 0
  private pending?: AbortController
  private intent = 0
  private steps: Promise<void> = Promise.resolve()
  constructor(
    private readonly changed: () => void,
    private readonly source: () => TimeSource | undefined = () => undefined,
  ) {}
  get state(): TimeState {
    return {
      time: this.time,
      playing: this.playing,
      speed: this.speed,
      loop: this.loop,
      follow: this.follow,
      range: this.range,
    }
  }
  update(range: readonly [number, number] | null): void {
    this.range = range
    if (range) {
      this.time = this.follow ? range[1] : Math.max(range[0], Math.min(range[1], this.time))
      if (this.follow) this.frame = Math.max(0, (this.source()?.info?.rows ?? 1) - 1)
    } else {
      this.pause()
      this.time = 0
      this.frame = undefined
      this.follow = false
    }
    this.changed()
  }
  seek(time: number): void {
    if (!this.range || !Number.isFinite(time)) return
    this.intent++
    this.pending?.abort()
    this.follow = false
    this.frame = undefined
    this.time = Math.max(this.range[0], Math.min(this.range[1], time))
    this.changed()
  }
  async seekFrame(frame: number): Promise<void> {
    const source = this.source()
    if (!source?.info || !Number.isSafeInteger(frame) || frame < 0 || frame >= source.info.rows)
      return
    this.intent++
    this.pause()
    this.pending?.abort()
    const read = new AbortController()
    this.pending = read
    const time = await source.timeAt(frame, read.signal)
    if (read.signal.aborted || this.source() !== source) return
    this.follow = false
    this.frame = frame
    this.time = time
    this.changed()
  }
  step(direction: -1 | 1): Promise<void> {
    this.pause()
    this.follow = false
    const source = this.source()
    const intent = this.intent
    const next = this.steps
      .catch(() => {})
      .then(async () => {
        if (intent !== this.intent || !source?.info?.rows || this.source() !== source) return
        const read = new AbortController()
        this.pending = read
        const at = this.frame ?? (await source.locate(this.time, read.signal))
        const frame = Math.max(0, Math.min(source.info.rows - 1, at + direction))
        const time = await source.timeAt(frame, read.signal)
        if (!read.signal.aborted && this.source() === source) {
          this.frame = frame
          this.time = time
          this.changed()
        }
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') throw error
      })
    this.steps = next
    return next
  }
  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) throw new Error('Speed must be a positive number.')
    this.speed = speed
    this.last = Date.now()
    this.changed()
  }
  setLoop(loop: boolean): void {
    this.loop = loop
    this.changed()
  }
  followLatest(follow = true): void {
    this.intent++
    this.pending?.abort()
    this.pause()
    this.follow = follow
    this.update(this.range)
  }
  toggle(): void {
    if (this.playing) {
      this.pause()
      return
    }
    if (!this.range || this.range[0] === this.range[1]) return
    this.intent++
    this.follow = false
    this.pending?.abort()
    this.frame = undefined
    if (this.time >= this.range[1]) this.time = this.range[0]
    this.playing = true
    this.last = Date.now()
    this.changed()
    this.timer = setInterval(() => {
      const now = Date.now()
      const elapsed = (now - this.last) / 1000
      this.last = now
      const [start, end] = this.range!
      let time = this.time + elapsed * this.speed
      if (time >= end) {
        if (this.loop && end > start) time = start + ((time - start) % (end - start))
        else {
          this.time = end
          this.pause()
          return
        }
      }
      this.time = time
      this.frame = undefined
      this.changed()
    }, 50)
  }
  pause(): void {
    if (!this.playing) return
    clearInterval(this.timer)
    this.timer = undefined
    this.playing = false
    this.changed()
  }
  dispose(): void {
    this.intent++
    this.pending?.abort()
    clearInterval(this.timer)
    this.timer = undefined
  }
}
