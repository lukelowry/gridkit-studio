import { expect, it } from 'vitest'

import type { Results } from '../../shared/messages.js'
import { monitorWindow, sameWindow } from './plot.js'
it('uses exact run and chosen ranges without assuming uniform time spacing', () => {
  const results = { domain: [0, 12], span: [0, 100] } as unknown as Results
  expect(monitorWindow(results)).toEqual([0, 100])
  expect(monitorWindow(results, [0.1, 0.10001])).toEqual([0.1, 0.10001])
  expect(monitorWindow(undefined)).toEqual([0, 1])
  expect(monitorWindow({ domain: [12, 12] } as unknown as Results)).toEqual([12, 13])
  expect(sameWindow([1, 2], [1, 2])).toBe(true)
  expect(sameWindow([1, 2], [1, 3])).toBe(false)
})
