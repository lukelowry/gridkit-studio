import { describe, expect, it } from 'vitest'

import { formatNumber } from './format.js'

describe('numbers for display', () => {
  it('shows six significant digits, and the extremes as exponents', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(1.5e7)).toBe('1.5e+7')
    expect(formatNumber(NaN)).toBe('—')
    expect(formatNumber(-Infinity)).toBe('-∞')
  })
})
