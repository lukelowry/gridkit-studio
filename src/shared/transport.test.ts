import { afterEach, describe, expect, it, vi } from 'vitest'

import { advance, clamp, type ClockState, IDLE, Transport } from './transport.js'

const SPAN: readonly [number, number] = [0, 10]

/** A state playing SPAN from 0 at rate 1, unless `over` says otherwise. */
const playing = (over: Partial<ClockState> = {}): ClockState => ({
  ...IDLE,
  epoch: 1,
  status: 'playing',
  span: SPAN,
  ...over,
})

/** A transport on a manual wall clock, with every change it reports. */
function rig() {
  let now = 1_000
  const changes: ClockState[] = []
  const transport = new Transport(
    (state) => changes.push(state),
    () => now,
  )
  return { transport, changes, wait: (ms: number) => (now += ms) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('clamp', () => {
  it('keeps a time within the span', () => {
    expect(clamp(-1, SPAN)).toBe(0)
    expect(clamp(4, SPAN)).toBe(4)
    expect(clamp(11, SPAN)).toBe(10)
  })
})

describe('advance', () => {
  it('holds a clock that is not playing, within its span', () => {
    expect(advance(playing({ status: 'paused', t: 4 }), 5_000).t).toBe(4)
    expect(advance(playing({ status: 'paused', t: 99 }), 0)).toEqual({ t: 10, ended: false })
  })

  it('moves a playing clock by the time passed and its rate, and stops it at the end', () => {
    expect(advance(playing({ t: 1, rate: 2 }), 1_500)).toEqual({ t: 4, ended: false })
    expect(advance(playing({ t: 9 }), 2_000)).toEqual({ t: 10, ended: true })
    expect(advance(playing({ t: 9 }), 1_000)).toEqual({ t: 10, ended: true })
    // Every time of an empty span is its end.
    expect(advance(playing({ t: 3, span: [3, 3] }), 500)).toEqual({ t: 3, ended: true })
  })
})

describe('Transport', () => {
  it('takes a span on as a new epoch, paused at its start, and drops it back to idle', () => {
    const { transport, changes } = rig()
    expect(transport.state).toBe(IDLE)
    transport.setSpan([0, 4])
    expect(transport.state).toEqual({
      epoch: 1,
      status: 'paused',
      t: 0,
      rate: 1,
      span: [0, 4],
      follow: false,
    })
    transport.setSpan([2, 6], { live: true })
    expect(transport.state).toMatchObject({ epoch: 2, t: 2, span: [2, 6], follow: true })
    expect(transport.live).toBe(true)
    transport.clear()
    expect(transport.state).toMatchObject({
      epoch: 3,
      status: 'idle',
      t: 0,
      span: [0, 0],
      follow: false,
    })
    expect(transport.live).toBe(false)
    expect(changes).toHaveLength(3)

    transport.play()
    transport.seek(1)
    transport.goLive()
    transport.setRate(2)
    expect(changes).toHaveLength(3)
  })

  it('plays other results at the speed the results before played at, until it is cleared', () => {
    const { transport } = rig()
    transport.setSpan([0, 4])
    transport.setRate(2)
    transport.setSpan([0, 8])
    expect(transport.state).toMatchObject({ epoch: 2, rate: 2, t: 0, status: 'paused' })
    transport.clear()
    transport.setSpan([0, 8])
    expect(transport.state.rate).toBe(1)
  })

  it('follows a live head, lets go on a seek back, and latches again at the head', () => {
    const { transport, changes } = rig()
    transport.setSpan([0, 1], { live: true, headTolerance: 0.25 })
    transport.grow(0.75)
    expect(transport.state.t).toBe(0.75)
    expect(changes).toHaveLength(2)

    transport.seek(0.2)
    expect(transport.state).toMatchObject({ t: 0.2, follow: false })
    // A playhead behind the head stays put, and nothing changes that anyone need hear of.
    transport.grow(0.9)
    expect(transport.state.t).toBe(0.2)
    expect(changes).toHaveLength(3)

    transport.seek(0.7)
    expect(transport.state).toMatchObject({ t: 0.9, follow: true, status: 'paused' })
    transport.setLive(true)
    expect(changes).toHaveLength(4)
    transport.setLive(false)
    expect(transport.state).toMatchObject({ t: 0.9, follow: false })
    expect(changes).toHaveLength(5)
  })

  it('widens its span as frames arrive past it, keeping the epoch and where the playhead is', () => {
    const { transport, changes } = rig()
    transport.grow(5)
    expect(transport.state.status).toBe('idle')
    transport.setSpan([0, 1])
    transport.seek(0.5)
    transport.grow(3)
    expect(transport.state).toMatchObject({ span: [0, 3], t: 0.5, epoch: 1 })
    transport.grow(2)
    expect(transport.state.span).toEqual([0, 3])
    expect(changes).toHaveLength(3)
  })

  it('moves a following playhead with the span as it widens, in one change each time', () => {
    const { transport, changes } = rig()
    transport.setSpan([0, 1], { live: true })
    transport.grow(2)
    expect(transport.state).toMatchObject({ span: [0, 2], t: 2, follow: true })
    // Frames that reach no further still move the head the playhead follows.
    transport.seek(0)
    transport.seek(2)
    transport.grow(2)
    expect(changes).toHaveLength(5)
    expect(transport.state.t).toBe(2)
  })

  it('keeps a playhead that stopped following where it is when frames stop', () => {
    const { transport, changes } = rig()
    transport.setSpan([0, 1], { live: true })
    transport.grow(0.5)
    transport.seek(0)
    expect(transport.state.follow).toBe(false)
    transport.setLive(false)
    expect(transport.state.t).toBe(0)
    expect(changes).toHaveLength(3)
  })

  it('plays a finished span that plays once from its start again, and never an empty one', () => {
    const { transport } = rig()
    transport.setSpan([5, 7])
    transport.seek(7)
    transport.playPause()
    expect(transport.state).toMatchObject({ t: 5, status: 'playing', follow: false })
    transport.playPause()
    expect(transport.state.status).toBe('paused')

    transport.setSpan([5, 5])
    transport.play()
    expect(transport.state).toMatchObject({ t: 5, status: 'paused' })
    transport.dispose()
  })

  it('keeps a live span where it is when played at its end, since more is coming', () => {
    const { transport } = rig()
    transport.setSpan([0, 2], { live: true })
    transport.grow(2)
    transport.play()
    expect(transport.state).toMatchObject({ t: 2, status: 'playing', follow: false })
    transport.dispose()
  })

  it('jumps back to the head and follows it, without the clock drifting between frames', () => {
    const { transport, wait } = rig()
    transport.setSpan([5, 15], { live: true })
    transport.grow(7)
    transport.seek(5)
    transport.play()
    wait(100)
    transport.goLive()
    expect(transport.state).toMatchObject({ t: 7, status: 'paused', follow: true })
    wait(500)
    expect(transport.currentT()).toBe(7)
    transport.grow(8)
    expect(transport.currentT()).toBe(8)

    transport.play()
    transport.seek(15)
    wait(500)
    expect(transport.currentT()).toBe(8)
    expect(transport.state.status).toBe('paused')

    transport.setLive(false)
    transport.seek(6)
    transport.goLive()
    expect(transport.state).toMatchObject({ t: 6, follow: false })
    transport.dispose()
  })

  it('plays at its rate, and changes rate from where the playhead is', () => {
    const { transport, wait } = rig()
    transport.setSpan([0, 100])
    transport.play()
    wait(1_000)
    expect(transport.currentT()).toBeCloseTo(1, 9)
    transport.setRate(4)
    expect(transport.state.t).toBeCloseTo(1, 9)
    wait(500)
    expect(transport.currentT()).toBeCloseTo(3, 9)
    transport.setRate(0)
    transport.setRate(-1)
    expect(transport.state.rate).toBe(4)
    transport.pause()
    expect(transport.state).toMatchObject({ status: 'paused' })
    expect(transport.state.t).toBeCloseTo(3, 9)
    transport.pause()
    transport.dispose()
  })

  it('pauses at the end of its span, woken by its own alarm, and reports it', () => {
    vi.useFakeTimers()
    const { transport, wait, changes } = rig()
    transport.setSpan([0, 1])
    transport.play()
    wait(250)
    expect(transport.currentT()).toBeCloseTo(0.25, 9)
    wait(850)
    vi.advanceTimersByTime(1_100)
    expect(transport.state).toMatchObject({ status: 'paused', t: 1 })
    expect(changes.at(-1)).toMatchObject({ status: 'paused', t: 1 })
    transport.dispose()
  })

  it('plays on through a span longer than a timer can wait, and pauses only at its end', () => {
    vi.useFakeTimers()
    const { transport, wait } = rig()
    // A thousand days, which no single timer waits out.
    const days = 1_000
    const day = 86_400_000
    transport.setSpan([0, days * 86_400])
    transport.play()
    for (let elapsed = 0; elapsed < days; elapsed += 10) {
      wait(10 * day)
      vi.advanceTimersByTime(10 * day)
      if (elapsed + 10 < days) expect(transport.state.status).toBe('playing')
    }
    wait(day)
    vi.advanceTimersByTime(day)
    expect(transport.state).toMatchObject({ status: 'paused', t: days * 86_400 })
    transport.dispose()
  })

  it('settles at the edge when paused after the end has passed', () => {
    const { transport, wait } = rig()
    transport.setSpan([0, 1])
    transport.play()
    wait(5_000)
    transport.pause()
    expect(transport.state).toMatchObject({ status: 'paused', t: 1 })
    transport.dispose()
  })

  it('stops its alarm when disposed', () => {
    vi.useFakeTimers()
    const { transport, changes } = rig()
    transport.setSpan([0, 1])
    transport.play()
    const reported = changes.length
    transport.dispose()
    vi.advanceTimersByTime(5_000)
    expect(changes).toHaveLength(reported)
  })

  it('gives a reader the clock settled at the instant it asks', () => {
    const { transport, wait } = rig()
    transport.setSpan([0, 10])
    transport.play()
    wait(4_000)
    // `state` itself holds the last change.
    expect(transport.snapshot()).toMatchObject({ status: 'playing', t: 4 })
    expect(transport.state).toMatchObject({ status: 'playing', t: 0 })
    transport.dispose()
  })

  it('reads the wall clock by default', () => {
    const transport = new Transport(() => {})
    transport.setSpan([0, 1000])
    transport.play()
    expect(transport.currentT()).toBeGreaterThanOrEqual(0)
    transport.dispose()
  })
})
