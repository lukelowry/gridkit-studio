import { expect, it } from 'vitest'

import type { Results } from '../../shared/messages.js'
import { monitorWindow, plotCamera, sameWindow } from './plot.js'
it("shows the chosen window, else the run's whole span, and never an empty one", () => {
  const results = { domain: [0, 12], span: [0, 100] } as unknown as Results
  expect(monitorWindow(results)).toEqual([0, 100])
  expect(monitorWindow(results, [0.1, 0.10001])).toEqual([0.1, 0.10001])
  expect(monitorWindow(undefined)).toEqual([0, 1])
  expect(monitorWindow({ domain: [12, 12] } as unknown as Results)).toEqual([12, 13])
  expect(sameWindow([1, 2], [1, 2])).toBe(true)
  expect(sameWindow([1, 2], [1, 3])).toBe(false)
})
it('frames a plot over the values it was given, else those it shows', () => {
  const one = { table: 'Bus', field: 'Vm', id: 7, range: [0.9, 1.1] as const }
  expect(plotCamera(one, [0, 2])).toEqual({ x: [0, 2], y: [0.9, 1.1] })
  expect(plotCamera({ table: 'Bus', field: 'Vm' }, [0, 2])).toEqual({ x: [0, 2], y: null })
})
