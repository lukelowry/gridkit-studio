import { describe, expect, it, vi } from 'vitest'

import { ResultCache } from './cache.js'

describe('idle results files a worker keeps', () => {
  it('keeps a file under the budget until it is opened again or past it, idle longest first', () => {
    const cache = new ResultCache(4)
    const [first, reopened, second] = [vi.fn(), vi.fn(), vi.fn()]
    cache.add({}, 2, first)
    const opened = {}
    cache.add(opened, 1, reopened)
    cache.remove(opened)
    expect(cache.bytes).toBe(2)
    // A later idle file evicts the first.
    cache.add({}, 3, second)
    expect(first).toHaveBeenCalledOnce()
    expect(cache.bytes).toBe(3)
    expect(reopened).not.toHaveBeenCalled()
    // A lower limit evicts right away, and a file larger than the whole budget is never kept.
    cache.limit = 2
    expect(second).toHaveBeenCalledOnce()
    const large = vi.fn()
    cache.add({}, 3, large)
    expect(large).toHaveBeenCalledOnce()
    expect(cache.bytes).toBe(0)
  })
})
