import { describe, expect, it } from 'vitest'

import { bound, channelsFor, channelsOf, shortNames } from './bindings.js'

const vm = { table: 'Bus', field: 'Vm' }
const kv = { table: 'Bus', field: 'params.kv' }
const vertex = channelsFor('vertex')

describe('bindings', () => {
  it('offers each placement its own channels, and a type the network does not draw none', () => {
    expect(vertex).toEqual(['vertexColor', 'vertexSize', 'vertexHeight'])
    expect(channelsFor('edge')).toEqual(['edgeColor', 'edgeWidth', 'edgeDash'])
    expect(channelsFor(null)).toEqual([])
  })

  it('makes a field drive exactly the channels named, taking them from whoever drove them', () => {
    const first = bound({}, vertex, kv, ['vertexColor', 'vertexSize'])
    expect(channelsOf(first, kv)).toEqual(['vertexColor', 'vertexSize'])
    const second = bound(first, vertex, vm, ['vertexColor', 'vertexHeight'], [0.9, 1.1])
    expect(channelsOf(second, kv)).toEqual(['vertexSize'])
    expect(second.vertexColor).toEqual({ ...vm, domain: [0.9, 1.1] })
    expect(second.vertexHeight).toEqual({ ...vm, domain: [0.9, 1.1] })
    // Each change returns a new record and leaves its input untouched.
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

  it('names channels by one word each', () => {
    expect(shortNames(['vertexColor', 'vertexHeight'])).toBe('color, height')
    expect(shortNames([])).toBe('')
  })
})
