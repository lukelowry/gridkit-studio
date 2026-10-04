import { describe, expect, it } from 'vitest'

import { holdFor } from './streams.js'

describe('the window of a run a view holds', () => {
  it('holds the times it needs with a margin either side', () => {
    expect(holdFor(undefined, [10, 20], false, 10)).toEqual({ from: 0, to: 30 })
    expect(holdFor(undefined, [4, 9], false, 0)).toEqual({ from: 4, to: 9 })
  })

  it('keeps what it holds while that covers the need, and lets it go once the need leaves', () => {
    const held = { from: 0, to: 30 }
    expect(holdFor(held, [5, 15], false, 10)).toBe(held)
    expect(holdFor(held, [20, 30], false, 10)).toBe(held)
    expect(holdFor(held, [25, 35], false, 10)).toEqual({ from: 15, to: 45 })
    expect(holdFor(held, [-5, 5], false, 10)).toEqual({ from: -15, to: 15 })
  })

  it('holds an open window from its start on, so arriving frames are appended', () => {
    const open = holdFor(undefined, [10, 20], true, 10)
    expect(open).toEqual({ from: 0 })
    // The need follows the head: the same window serves until it trails three spans behind.
    expect(holdFor(open, [25, 35], true, 10)).toBe(open)
    expect(holdFor(open, [30, 40], true, 10)).toBe(open)
    expect(holdFor(open, [31, 41], true, 10)).toEqual({ from: 21 })
  })

  it('starts over when the view turns from following the head to a span, or back', () => {
    expect(holdFor({ from: 0 }, [5, 15], false, 0)).toEqual({ from: 5, to: 15 })
    expect(holdFor({ from: 0, to: 30 }, [5, 15], true, 0)).toEqual({ from: 5 })
  })
})
