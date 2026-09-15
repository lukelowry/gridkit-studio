import { elementAt, itemOf } from '@latkit/model'
import { describe, expect, it } from 'vitest'

import { parse as parseCase } from '../src/gridkit/parse.js'
const parse = (bytes: Uint8Array) => parseCase(bytes).model

import { caseBytes } from './support/case.js'

const TWO_BUS = caseBytes({
  header: { case_name: 'TwoBus' },
  buses: [
    { number: 1, class: 'Bus', name: 'A', extension: { longitude: -96.3, latitude: 30.6 } },
    { number: 2, class: 'Bus', name: 'B', extension: { longitude: -97.7, latitude: 30.3 } },
  ],
  devices: [
    { class: 'Branch', id: 'line_1', ports: { bus1: 1, bus2: 2 }, params: {}, extension: {} },
    { class: 'Genrou', id: 'DV1', ports: { bus: 2 } },
    { class: 'Signalsource', id: 'S1', ports: { out: 1 } },
  ],
})

describe('gridkit owners and anchors', () => {
  it('names buses as the vertex owner and branches as the edge owner', () => {
    const model = parse(TWO_BUS)
    expect(model.owners).toEqual({ vertex: 'bus', edge: 'branch' })
    expect(elementAt(model, { kind: 'vertex', index: 1 })).toEqual({ classId: 'bus', index: 1 })
    expect(elementAt(model, { kind: 'edge', index: 0 })).toEqual({ classId: 'branch', index: 0 })
    expect(elementAt(model, { kind: 'vertex', index: 2 })).toBeNull()
    expect(elementAt(model, { kind: 'edge', index: 1 })).toBeNull()
  })

  it('places owners by identity and devices at the bus their ports name', () => {
    const model = parse(TWO_BUS)
    expect(itemOf(model, { classId: 'bus', index: 0 })).toEqual({ kind: 'vertex', index: 0 })
    expect(itemOf(model, { classId: 'branch', index: 0 })).toEqual({ kind: 'edge', index: 0 })
    expect(itemOf(model, { classId: 'genrou', index: 0 })).toEqual({ kind: 'vertex', index: 1 })
    expect(itemOf(model, { classId: 'signalsource', index: 0 })).toBeNull() // no `ports.bus`
    expect(itemOf(model, { classId: 'nope', index: 0 })).toBeNull()
    expect(itemOf(model, { classId: 'bus', index: 9 })).toBeNull()
  })

  it('declares no edge owner when the case has no branches', () => {
    const model = parse(caseBytes({ buses: [{ number: 1 }], devices: [] }))
    expect(model.owners).toEqual({ vertex: 'bus' })
    expect(model.topology.edges).toHaveLength(0)
  })
})
