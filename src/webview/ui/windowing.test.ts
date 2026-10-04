import { describe, expect, it } from 'vitest'

import { centerOffset, revealOffset, windowSize, windowStart } from './windowing.js'

describe('windowing', () => {
  it('mounts the rows in view plus the overscan on each side', () => {
    expect(windowStart(0, 30, 6)).toBe(0)
    expect(windowStart(100, 30, 6)).toBe(0)
    expect(windowStart(3000, 30, 6)).toBe(94)
    expect(windowSize(300, 30, 6)).toBe(22)
    expect(windowSize(0, 30, 6)).toBe(13) // an unmeasured viewport still mounts a row
  })

  it('scrolls only as far as a band needs, and centers on request', () => {
    expect(revealOffset(100, 300, 150, 30)).toBe(100) // already in view
    expect(revealOffset(100, 300, 40, 30)).toBe(40) // above: its top edge aligns
    expect(revealOffset(100, 300, 420, 30)).toBe(150) // below: its bottom edge aligns
    expect(centerOffset(300, 600, 30)).toBe(465)
    expect(centerOffset(300, 30, 30)).toBe(0)
  })
})
