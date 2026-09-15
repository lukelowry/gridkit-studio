import { afterEach, expect, it, vi } from 'vitest'

import { Timeline } from '../src/timeline.js'
afterEach(() => vi.useRealTimers())
it('shares seconds, clamps seeks, and stops exactly at the recorded end', () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  const clock = new Timeline(changed)
  clock.update([1, 2])
  expect(clock.time).toBe(1)
  clock.seek(-5)
  expect(clock.time).toBe(1)
  clock.seek(NaN)
  expect(clock.time).toBe(1)
  clock.toggle()
  vi.advanceTimersByTime(1500)
  expect(clock.time).toBe(2)
  expect(clock.playing).toBe(false)
  clock.toggle()
  expect(clock.time).toBe(1)
  clock.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

it('steps through equal-time event samples and follows appended samples without losing frame identity', async () => {
  const times = [0, 1, 1, 2]
  const source = {
    info: { rows: 4, range: [0, 2] as const },
    locate: async () => 2,
    timeAt: async (frame: number) => times[frame],
  }
  const clock = new Timeline(
    () => {},
    () => source,
  )
  clock.update(source.info.range)
  await clock.seekFrame(1)
  expect(clock.frame).toBe(1)
  expect(clock.time).toBe(1)
  await clock.step(1)
  expect(clock.frame).toBe(2)
  expect(clock.time).toBe(1)
  await clock.step(-1)
  expect(clock.frame).toBe(1)
  expect(clock.time).toBe(1)
  clock.followLatest()
  expect(clock.frame).toBe(3)
  expect(clock.time).toBe(2)
  times.push(3)
  source.info = { rows: 5, range: [0, 3] as unknown as readonly [0, 2] }
  clock.update([0, 3])
  expect(clock.frame).toBe(4)
  clock.seek(1)
  expect(clock.follow).toBe(false)
  expect(clock.frame).toBeUndefined()
  clock.dispose()
})
it('applies speed and looping to the shared time position', () => {
  vi.useFakeTimers()
  const clock = new Timeline(() => {})
  clock.update([0, 2])
  clock.setSpeed(2)
  clock.setLoop(true)
  clock.toggle()
  vi.advanceTimersByTime(1250)
  expect(clock.time).toBeCloseTo(0.5)
  expect(clock.playing).toBe(true)
  clock.dispose()
})
