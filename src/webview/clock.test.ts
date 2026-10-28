import { afterEach, expect, it, vi } from 'vitest'

import type { Of, ToView } from '../shared/messages.js'
import { IDLE } from '../shared/transport.js'

const transport = vi.hoisted(() => ({
  listener: (_message: ToView) => {},
  report: vi.fn(),
  send: vi.fn(),
  of: { uri: 'file:///case.case.json', showing: 1 } as Of,
}))
vi.mock('./bridge.js', () => ({
  bridge: {
    on: (listener: (message: ToView) => void) => {
      transport.listener = listener
      return () => {}
    },
    report: transport.report,
    send: transport.send,
    get of() {
      return transport.of
    },
  },
}))
import { createClock } from './clock.js'

afterEach(() => vi.unstubAllGlobals())

const A: Of = { uri: 'file:///a.case.json', showing: 1 }
const B: Of = { uri: 'file:///b.case.json', showing: 2 }

it('computes playback time without owning a rendering RAF and survives a paint error', () => {
  vi.useFakeTimers({ toFake: ['performance'] })
  const request = vi.fn()
  vi.stubGlobal('requestAnimationFrame', request)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const paint = vi.fn().mockImplementationOnce(() => {
    throw new Error('temporary GPU failure')
  })
  const clock = createClock(paint)
  transport.listener({
    kind: 'clock',
    of: transport.of,
    seq: 0,
    live: false,
    clock: { ...IDLE, status: 'playing', span: [0, 10] },
  })
  vi.advanceTimersByTime(500)
  expect(clock.now()).toBeCloseTo(0.5)
  expect(request).not.toHaveBeenCalled()
  expect(transport.report).toHaveBeenCalledOnce()
  transport.listener({
    kind: 'clock',
    of: transport.of,
    seq: 1,
    live: false,
    clock: { ...IDLE, status: 'paused', t: 2, span: [0, 10] },
  })
  expect(paint).toHaveBeenLastCalledWith(2)
  clock.stop()
  vi.useRealTimers()
})

it('follows the clock of the case it shows next, whatever it changed of the one before', () => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  transport.of = A
  const paint = vi.fn()
  const clock = createClock(paint)
  const paused = { ...IDLE, status: 'paused' as const, span: [0, 10] as const }
  transport.listener({ kind: 'clock', of: A, seq: 0, live: false, clock: paused })
  // The view changes the clock of the case it shows, and moves on to another before the extension
  // hears it: the extension drops what it said of the case before.
  clock.act({ action: 'playPause' })
  clock.act({ action: 'playPause' })
  transport.of = B
  transport.listener({ kind: 'state', of: B, state: { uri: B.uri } })
  // Each showing counts its changes from naught, so the new case's clock is taken.
  transport.listener({ kind: 'clock', of: B, seq: 0, live: false, clock: { ...paused, t: 7 } })
  expect(clock.now()).toBe(7)
  // A clock of the case before is not the view's.
  transport.listener({ kind: 'clock', of: A, seq: 5, live: false, clock: { ...paused, t: 3 } })
  expect(clock.now()).toBe(7)
  clock.stop()
})
