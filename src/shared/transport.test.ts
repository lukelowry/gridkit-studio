import { afterEach, describe, expect, it, vi } from 'vitest'

import { advance, clamp, type ClockState, fold, IDLE, Transport } from './transport.js'

const SPAN: readonly [number, number] = [0, 10]

/** A state playing SPAN from 0 at rate 1 with no loop, unless `over` says otherwise. */
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

describe('clamp and fold', () => {
  it('keeps a time within the span', () => {
    expect(clamp(-1, SPAN)).toBe(0)
    expect(clamp(4, SPAN)).toBe(4)
    expect(clamp(11, SPAN)).toBe(10)
  })

  it('stops a playhead that plays once at an end, and says it ran past', () => {
    expect(fold(5, SPAN, 'none', 1)).toEqual({ t: 5, direction: 1, ended: false })
    expect(fold(12, SPAN, 'none', 1)).toEqual({ t: 10, direction: 1, ended: true })
    expect(fold(10, SPAN, 'none', 1)).toEqual({ t: 10, direction: 1, ended: true })
    expect(fold(10, SPAN, 'none', -1)).toEqual({ t: 10, direction: -1, ended: false })
    expect(fold(0, SPAN, 'none', 1)).toEqual({ t: 0, direction: 1, ended: false })
    expect(fold(-2, SPAN, 'none', -1)).toEqual({ t: 0, direction: -1, ended: true })
  })

  it('wraps around a looping span and bounces off the ends of a pingpong one', () => {
    expect(fold(12, SPAN, 'wrap', 1).t).toBeCloseTo(2, 12)
    expect(fold(-3, SPAN, 'wrap', 1).t).toBeCloseTo(7, 12)
    expect(fold(12, SPAN, 'wrap', 1).ended).toBe(false)
    expect(fold(13, SPAN, 'pingpong', 1)).toMatchObject({ direction: -1, ended: false })
    expect(fold(13, SPAN, 'pingpong', 1).t).toBeCloseTo(7, 12)
    expect(fold(13, SPAN, 'pingpong', -1).direction).toBe(1)
    expect(fold(24, SPAN, 'pingpong', 1)).toMatchObject({ direction: 1 })
    expect(fold(24, SPAN, 'pingpong', 1).t).toBeCloseTo(4, 12)
  })

  it('pins every time of an empty span to its start', () => {
    expect(fold(5, [3, 3], 'none', 1)).toEqual({ t: 3, direction: 1, ended: true })
    expect(fold(5, [3, 3], 'wrap', 1)).toEqual({ t: 3, direction: 1, ended: false })
  })
})

describe('advance', () => {
  it('holds a clock that is not playing, within its span', () => {
    expect(advance(playing({ status: 'paused', t: 4 }), 5_000).t).toBe(4)
    expect(advance(playing({ status: 'paused', t: 99 }), 0)).toEqual({
      t: 10,
      direction: 1,
      ended: false,
    })
  })

  it('moves a playing clock by the time passed, its rate and its direction', () => {
    expect(advance(playing({ t: 1, rate: 2 }), 1_500).t).toBeCloseTo(4, 12)
    expect(advance(playing({ t: 9 }), 2_000)).toMatchObject({ t: 10, ended: true })
    expect(advance(playing({ t: 5, loop: 'pingpong', direction: -1 }), 2_000).t).toBeCloseTo(3, 12)
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
      loop: 'none',
      direction: 1,
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
    transport.setLoop('wrap')
    expect(changes).toHaveLength(3)
  })

  it('follows a live head without a word, lets go on a seek back, and latches again at the head', () => {
    const { transport, changes } = rig()
    transport.setSpan([0, 1], { live: true, headTolerance: 0.25 })
    expect(transport.noteHead(0.75)).toBe(true)
    expect(transport.state.t).toBe(0.75)
    expect(changes).toHaveLength(1)

    transport.seek(0.2)
    expect(transport.state).toMatchObject({ t: 0.2, follow: false })
    expect(transport.noteHead(0.9)).toBe(false)
    expect(transport.state.t).toBe(0.2)

    transport.seek(0.7)
    expect(transport.state).toMatchObject({ t: 0.9, follow: true, status: 'paused' })
    transport.setLive(true)
    expect(changes).toHaveLength(3)
    transport.setLive(false)
    expect(transport.state).toMatchObject({ t: 0.9, follow: false })
    expect(changes).toHaveLength(4)
  })

  it('widens its span as frames arrive past it, keeping the epoch and where the playhead is', () => {
    const { transport, changes } = rig()
    transport.extend(5)
    expect(transport.state.status).toBe('idle')
    transport.setSpan([0, 1])
    transport.seek(0.5)
    transport.extend(3)
    expect(transport.state).toMatchObject({ span: [0, 3], t: 0.5, epoch: 1 })
    transport.extend(2)
    expect(transport.state.span).toEqual([0, 3])
    expect(changes).toHaveLength(3)
  })

  it('keeps a playhead that stopped following where it is when frames stop', () => {
    const { transport, changes } = rig()
    transport.setSpan([0, 1], { live: true })
    transport.noteHead(0.5)
    transport.seek(0)
    expect(transport.state.follow).toBe(false)
    transport.setLive(false)
    expect(transport.state.t).toBe(0)
    expect(changes).toHaveLength(2)
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
    transport.noteHead(2)
    transport.play()
    expect(transport.state).toMatchObject({ t: 2, status: 'playing', follow: false })
    transport.dispose()
  })

  it('jumps back to the head and follows it, without the clock drifting between frames', () => {
    const { transport, wait } = rig()
    transport.setSpan([5, 15], { live: true })
    transport.noteHead(7)
    transport.seek(5)
    transport.play()
    wait(100)
    transport.goLive()
    expect(transport.state).toMatchObject({ t: 7, status: 'paused', follow: true })
    wait(500)
    expect(transport.currentT()).toBe(7)
    transport.noteHead(8)
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

  it('wraps and bounces as its loop says, keeping direction only while bouncing', () => {
    const { transport, wait } = rig()
    transport.setSpan([0, 10])
    transport.setLoop('wrap')
    transport.play()
    wait(12_000)
    expect(transport.currentT()).toBeCloseTo(2, 9)

    transport.setLoop('pingpong')
    wait(10_000)
    expect(transport.currentT()).toBeCloseTo(8, 9)
    transport.pause()
    expect(transport.state).toMatchObject({ direction: -1, loop: 'pingpong' })
    transport.setLoop('none')
    expect(transport.state.direction).toBe(1)
    transport.dispose()
  })

  it('pauses at the end of a span it plays once, woken by its own alarm, and reports it', () => {
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
    transport.setLoop('pingpong')
    transport.play()
    wait(12_000)
    // Two seconds back from the far end; `state` itself holds the last change.
    expect(transport.snapshot()).toMatchObject({ status: 'playing', direction: -1 })
    expect(transport.snapshot().t).toBeCloseTo(8, 12)
    expect(transport.state).toMatchObject({ t: 0, direction: 1 })
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
