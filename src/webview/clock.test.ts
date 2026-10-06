import { afterEach, expect, it, vi } from 'vitest'

import type { ToView } from '../shared/messages.js'
import { IDLE } from '../shared/transport.js'

const transport = vi.hoisted(() => ({ listener: (_message: ToView) => {}, report: vi.fn() }))
vi.mock('./bridge.js', () => ({
  bridge: {
    on: (listener: (message: ToView) => void) => {
      transport.listener = listener
      return () => {}
    },
    report: transport.report,
  },
}))
import { createClock } from './clock.js'

afterEach(() => vi.unstubAllGlobals())

it('keeps scheduling the playhead after a transient renderer exception', () => {
  let next: FrameRequestCallback = () => {}
  const request = vi.fn((callback: FrameRequestCallback) => {
    next = callback
    return 1
  })
  vi.stubGlobal('requestAnimationFrame', request)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const paint = vi.fn().mockImplementationOnce(() => {
    throw new Error('temporary GPU failure')
  })
  const clock = createClock(paint)
  transport.listener({
    kind: 'clock',
    seq: 0,
    live: false,
    clock: { ...IDLE, status: 'playing', span: [0, 10] },
  })
  expect(request).toHaveBeenCalledTimes(1)
  next(16)
  expect(paint).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenCalledTimes(2)
  expect(transport.report).toHaveBeenCalledTimes(1)
  clock.stop()
})
