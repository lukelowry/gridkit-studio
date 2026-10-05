import { createData, type Data } from '@latkit/model'
import { describe, expect, it } from 'vitest'

import { NETWORK, patchOf, same } from './patch.js'

const data = (): Data => createData({ types: {} }, [])

describe('the least patch', () => {
  it('compares options by value, and data and typed arrays by identity', () => {
    const source = data()
    const values = Float64Array.of(1, 2)
    expect(
      same(
        { color: [1, 0, 0, 1], font: { family: 'mono' } },
        { color: [1, 0, 0, 1], font: { family: 'mono' } },
      ),
    ).toBe(true)
    expect(same({ labels: null }, {})).toBe(true)
    expect(same({ source }, { source })).toBe(true)
    expect(same({ source }, { source: data() })).toBe(false)
    expect(same({ x: values }, { x: Float64Array.of(1, 2) })).toBe(false)
  })

  it('tells nothing when nothing changed, however the config was made', () => {
    const source = data()
    const config = () => ({
      source,
      background: [0, 0, 0, 1],
      vertices: {
        Bus: { x: 'position', y: { field: 'position', component: 1 }, labels: { field: 'name' } },
      },
    })
    expect(patchOf(config(), config(), NETWORK)).toBeNull()
  })

  it('tells a record only the entries and options that changed, and unsets the rest', () => {
    const source = data()
    const before = {
      source,
      vertices: {
        Bus: { x: 'position', color: 'Vm', labels: { field: 'name' } },
        Load: { x: 'p' },
      },
      edges: { Branch: { ends: ['from', 'to'], visible: false } },
    }
    const after = {
      source,
      vertices: { Bus: { x: 'position', radiusPx: 'Vm', labels: { field: 'name' } } },
      edges: { Branch: { ends: ['from', 'to'], visible: false } },
    }
    expect(patchOf(before, after, NETWORK)).toEqual({
      vertices: { Bus: { color: null, radiusPx: 'Vm' }, Load: null },
    })
  })

  it('merges a merged option per option, and replaces any other whole', () => {
    expect(
      patchOf(
        { input: { mode: 'navigate', wheel: 'zoom' }, font: { family: 'a', weight: 400 } },
        { input: { mode: 'edit', wheel: 'zoom' }, font: { family: 'b' } },
        NETWORK,
      ),
    ).toEqual({ input: { mode: 'edit' }, font: { family: 'b' } })
    expect(patchOf({ paths: { Coast: {} } }, { paths: null }, NETWORK)).toEqual({ paths: null })
  })
})
