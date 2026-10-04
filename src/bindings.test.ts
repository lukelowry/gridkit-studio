import { describe, expect, it } from 'vitest'

import { bound, channelsFor, channelsOf, fullNames, recordedWhole, shortNames } from './bindings.js'

const vm = { type: 'Bus', field: 'Vm' }
const kv = { type: 'Bus', field: 'kv' }
const vertex = channelsFor('vertex')

describe('bindings', () => {
  it('offers each placement its own channels, and a type the network does not draw none', () => {
    expect(vertex).toEqual(['vertexColor', 'vertexSize', 'vertexHeight'])
    expect(channelsFor('edge')).toEqual(['edgeColor', 'edgeDash'])
    expect(channelsFor(null)).toEqual([])
  })

  it('makes a field drive exactly the channels named, taking them from whoever drove them', () => {
    const first = bound({}, vertex, kv, ['vertexColor', 'vertexSize'])
    expect(channelsOf(first, kv)).toEqual(['vertexColor', 'vertexSize'])
    const second = bound(first, vertex, vm, ['vertexColor', 'vertexHeight'], [0.9, 1.1])
    expect(channelsOf(second, kv)).toEqual(['vertexSize'])
    expect(second.vertexColor).toEqual({ ...vm, domain: [0.9, 1.1] })
    expect(second.vertexHeight).toEqual({ ...vm, domain: [0.9, 1.1] })
    // The earlier bindings are untouched: each change is a new record.
    expect(first.vertexColor).toEqual(kv)
  })

  it('releases the channels a field drove and is no longer given', () => {
    const all = bound({}, vertex, vm, ['vertexColor', 'vertexSize'])
    expect(bound(all, vertex, vm, ['vertexSize'])).toEqual({ vertexSize: vm })
    expect(bound(all, vertex, vm, [])).toEqual({})
  })

  it('refuses a channel the field cannot drive', () => {
    expect(() => bound({}, vertex, vm, ['edgeColor'])).toThrow(/cannot drive Edge Color/)
  })

  it('counts a signal as recorded for mapping only when a run has it for every row', () => {
    const index = { type: 'Bus' } as never
    const all = [{ from: 'Bus', select: ['Vm', 'Va'] }]
    const some = [
      { from: 'Bus', select: ['Vm'], rows: { kind: 'indices', index, values: Uint32Array.of(0) } },
    ] as never
    const every = [
      {
        from: 'Bus',
        select: ['Vm'],
        rows: { kind: 'indices', index, values: Uint32Array.of(0, 1) },
      },
    ] as never
    expect(recordedWhole(all, 2, vm)).toBe(true)
    expect(recordedWhole(some, 2, vm)).toBe(false)
    expect(recordedWhole(every, 2, vm)).toBe(true)
    expect(recordedWhole(all, 2, kv)).toBe(false)
    expect(recordedWhole([{ from: 'Branch', select: ['Vm'] }], 2, vm)).toBe(false)
  })

  it('names channels in full and by one word each', () => {
    expect(fullNames(['vertexColor', 'vertexHeight'])).toBe('Vertex Color, Vertex Height')
    expect(shortNames(['vertexColor', 'vertexHeight'])).toBe('color, height')
    expect(shortNames([])).toBe('')
  })
})
