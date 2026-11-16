import { describe, expect, it } from 'vitest'

import type { CaseDefinition } from './document.js'
import { channelsFor, channelsOf, keptMappings, mappable, mapped } from './mappings.js'

const vm = { table: 'Bus', field: 'Vm' }
const kv = { table: 'Bus', field: 'params.kv' }
const vertex = channelsFor('vertex')

describe('mappings', () => {
  it('maps a field to exactly the channels named, taking them from any other field', () => {
    const first = mapped({}, vertex, kv, ['vertexColor', 'vertexSize'])
    expect(channelsOf(first, kv)).toEqual(['vertexColor', 'vertexSize'])
    const second = mapped(first, vertex, vm, ['vertexColor', 'vertexHeight'], [0.9, 1.1])
    expect(channelsOf(second, kv)).toEqual(['vertexSize'])
    expect(second.vertexColor).toEqual({ ...vm, range: [0.9, 1.1] })
    expect(second.vertexHeight).toEqual({ ...vm, range: [0.9, 1.1] })
    // Returns a new record and leaves the input untouched.
    expect(first.vertexColor).toEqual(kv)
  })

  it('clears the channels a field is no longer mapped to', () => {
    const all = mapped({}, vertex, vm, ['vertexColor', 'vertexSize'])
    expect(mapped(all, vertex, vm, ['vertexSize'])).toEqual({ vertexSize: vm })
    expect(mapped(all, vertex, vm, [])).toEqual({})
  })

  it('keeps only mappings on number fields the case has, of types the Network draws', () => {
    const field = (name: string, kind: 'number' | 'sampled' | 'text') => ({
      name,
      kind,
      label: name,
    })
    const definition: CaseDefinition = {
      tables: [
        {
          name: 'Bus',
          label: 'Bus',
          labelField: 'name',
          fields: [field('params.kv', 'number'), field('Vm', 'sampled'), field('name', 'text')],
        },
        {
          name: 'Genrou',
          label: 'GENROU',
          labelField: 'id',
          fields: [field('params.H', 'number')],
        },
      ],
      drawing: { geographic: false, vertices: [{ table: 'Bus', position: ['x', 'y'] }], edges: [] },
    }
    expect(mappable(definition, kv)).toBe(true)
    expect(mappable(definition, vm)).toBe(true)
    expect(mappable(definition, { table: 'Bus', field: 'name' })).toBe(false)
    expect(mappable(definition, { table: 'Genrou', field: 'params.H' })).toBe(false)
    const all = { vertexColor: kv, vertexSize: vm }
    expect(keptMappings(definition, all)).toBe(all)
    // A field renamed or removed from the case takes its mapping with it.
    const gone = { table: 'Bus', field: 'extension.weight' }
    expect(mappable(definition, gone)).toBe(false)
    expect(keptMappings(definition, { vertexColor: gone, vertexSize: vm })).toEqual({
      vertexSize: vm,
    })
  })

  it('refuses a channel the field cannot drive', () => {
    expect(() => mapped({}, vertex, vm, ['edgeColor'])).toThrow(/cannot drive Edge Color/)
  })
})
