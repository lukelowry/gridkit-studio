import { describe, expect, it } from 'vitest'

import { channelsFor, channelsOf, mapped } from './mappings.js'

const vm = { table: 'Bus', field: 'Vm' }
const kv = { table: 'Bus', field: 'params.kv' }
const vertex = channelsFor('vertex')

describe('mappings', () => {
  it('maps a field to exactly the channels named, taking them from whichever fields held them', () => {
    const first = mapped({}, vertex, kv, ['vertexColor', 'vertexSize'])
    expect(channelsOf(first, kv)).toEqual(['vertexColor', 'vertexSize'])
    const second = mapped(first, vertex, vm, ['vertexColor', 'vertexHeight'], [0.9, 1.1])
    expect(channelsOf(second, kv)).toEqual(['vertexSize'])
    expect(second.vertexColor).toEqual({ ...vm, range: [0.9, 1.1] })
    expect(second.vertexHeight).toEqual({ ...vm, range: [0.9, 1.1] })
    // Each change returns a new record and leaves its input untouched.
    expect(first.vertexColor).toEqual(kv)
  })

  it('lets go of the channels a field held and is no longer given', () => {
    const all = mapped({}, vertex, vm, ['vertexColor', 'vertexSize'])
    expect(mapped(all, vertex, vm, ['vertexSize'])).toEqual({ vertexSize: vm })
    expect(mapped(all, vertex, vm, [])).toEqual({})
  })

  it('refuses a channel the field cannot drive', () => {
    expect(() => mapped({}, vertex, vm, ['edgeColor'])).toThrow(/cannot drive Edge Color/)
  })
})
