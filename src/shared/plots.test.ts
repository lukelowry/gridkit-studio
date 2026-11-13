import { expect, it } from 'vitest'

import { plotsFor } from './plots.js'

it('keeps the plots a new run recorded, else plots its first signal', () => {
  const results = {
    outputs: [
      { table: 'Bus', field: 'Va', ids: [1] },
      { table: 'Bus', field: 'Vm', ids: [1] },
    ],
  }
  const vm = { table: 'Bus', field: 'Vm' }
  expect(plotsFor(results, [vm, { table: 'Bus', field: 'Pg' }])).toEqual([vm])
  expect(plotsFor(results, [{ table: 'Gen', field: 'Pg' }])).toEqual([
    { table: 'Bus', field: 'Va' },
  ])
  expect(plotsFor({ outputs: [] }, [vm])).toEqual([])
})
