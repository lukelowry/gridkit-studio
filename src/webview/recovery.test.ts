import { afterEach, expect, it, vi } from 'vitest'

import { Recovery } from './recovery.js'

afterEach(() => vi.useRealTimers())

it('coalesces failures, backs off repeated losses and keeps retrying', () => {
  vi.useFakeTimers()
  const restart = vi.fn()
  const report = vi.fn()
  const recovery = new Recovery(restart, report)
  for (const delay of [250, 500, 1000, 2000, 4000, 8000, 10_000, 10_000]) {
    const before = restart.mock.calls.length
    recovery.fail('lost')
    recovery.fail('same loss')
    vi.advanceTimersByTime(delay - 1)
    expect(restart).toHaveBeenCalledTimes(before)
    vi.advanceTimersByTime(1)
    expect(restart).toHaveBeenCalledTimes(before + 1)
    recovery.presented() // A briefly working replacement must not reset the backoff.
  }
  expect(report).toHaveBeenCalledTimes(1)
  recovery.fail('lost')
  recovery.dispose()
  vi.advanceTimersByTime(20_000)
  expect(restart).toHaveBeenCalledTimes(8)
})

it('resets backoff after sustained successful presentation', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const restart = vi.fn()
  const report = vi.fn()
  const recovery = new Recovery(restart, report)
  recovery.fail('lost')
  vi.advanceTimersByTime(250)
  recovery.presented()
  vi.advanceTimersByTime(10_000)
  recovery.presented()
  recovery.fail('another loss')
  vi.advanceTimersByTime(250)
  expect(restart).toHaveBeenCalledTimes(2)
  expect(report).toHaveBeenCalledTimes(2)
  recovery.dispose()
})
