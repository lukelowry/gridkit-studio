import { expect, it } from 'vitest'

import { shownOf, signalsOf } from './monitors.js'

it('lists the outputs of results once read, and before that what the case records', () => {
  const listed = { Bus: { Vm: 39, Va: 0 }, GENROU: { omega: 10 } }
  expect(signalsOf(undefined, listed)).toEqual([
    { table: 'Bus', field: 'Vm' },
    { table: 'GENROU', field: 'omega' },
  ])
  expect(signalsOf({ outputs: [] }, listed)).toHaveLength(2)
  const outputs = [{ table: 'Bus', field: 'Va', ids: [1] }]
  expect(signalsOf({ outputs }, listed)).toEqual([{ table: 'Bus', field: 'Va' }])
})

it('shows the monitors named, in list order, else the first', () => {
  const [vm, va, omega] = [
    { table: 'Bus', field: 'Vm' },
    { table: 'Bus', field: 'Va', range: [-1, 1] as const },
    { table: 'GENROU', field: 'omega' },
  ]
  const monitors = [vm!, va!, omega!]
  expect(shownOf(monitors, [omega!, { table: 'Bus', field: 'Va' }])).toEqual([va, omega])
  expect(shownOf(monitors, [{ table: 'Gen', field: 'Pg' }])).toEqual([vm])
  expect(shownOf([], [vm!])).toEqual([])
})
