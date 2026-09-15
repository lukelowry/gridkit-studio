import { expect, it } from 'vitest'

import { createAxis, paddedDomain, position } from '../src/monitor/axes.js'

it('labels tiny differences explicitly without rounding distinct ticks to the same value', () => {
  const axis = createAxis([1, 1 + 1e-8], 180, true)
  expect(axis.annotation).toContain('1 + tick')
  expect(axis.ticks.length).toBeGreaterThan(1)
  expect(new Set(axis.ticks.map((tick) => tick.label)).size).toBe(axis.ticks.length)
  for (const tick of axis.ticks) expect(tick.position).toBeGreaterThanOrEqual(-1e-9)
})
it('fits tick density to available pixels and keeps time labels in their domain', () => {
  expect(createAxis([0, 2], 900).ticks.length).toBeGreaterThan(createAxis([0, 2], 180).ticks.length)
  for (const tick of createAxis([0.5, 1.5], 640).ticks) {
    expect(tick.value).toBeGreaterThanOrEqual(0.5)
    expect(tick.value).toBeLessThanOrEqual(1.5)
  }
})
it('pads automatic ranges and keeps extreme finite domains usable', () => {
  expect(paddedDomain([1, 2])).toEqual([0.95, 2.05])
  const domain = paddedDomain([1e20, 1e20])
  expect(domain[0]).toBeLessThan(1e20)
  expect(domain[1]).toBeGreaterThan(1e20)
  expect(position(0, [-1e308, 1e308])).toBe(0.5)
  expect(createAxis([-1e308, 1e308], 600).ticks.length).toBeGreaterThan(1)
})
