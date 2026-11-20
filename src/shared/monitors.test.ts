import { expect, it } from 'vitest'

import { type CaseDefinition, fieldKey } from './document.js'
import { monitorName, shownOf, signalsOf } from './monitors.js'

it('keeps monitor names readable with and without a case definition', () => {
  const document: CaseDefinition = {
    tables: [
      {
        name: 'bus',
        label: 'Bus',
        labelField: 'name',
        fields: [{ name: 'mon.Vm', label: 'Vm', kind: 'sampled', unit: 'p.u.' }],
      },
    ],
    drawing: { geographic: false, vertices: [], edges: [] },
  }
  const monitor = { table: 'bus', field: 'mon.Vm' }
  expect(monitorName(document, monitor)).toBe('Bus Vm [p.u.]')
  expect(monitorName(document, { ...monitor, id: 0 })).toBe('Bus 0 Vm [p.u.]')
  expect(monitorName(document, monitor, 'field')).toBe('Vm')
  expect(monitorName(undefined, { table: 'Bus', field: 'Va', id: 'north' })).toBe('Bus north Va')
})

it('distinguishes fields whose names contain periods', () => {
  expect(fieldKey({ table: 'A.B', field: 'C' })).not.toBe(fieldKey({ table: 'A', field: 'B.C' }))
})

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
