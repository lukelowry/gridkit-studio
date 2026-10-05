import { describe, expect, it } from 'vitest'

import { Case, catalog } from './index.js'
import { aggregate, neighborhood, selectIds } from './inspection.js'

const signal = new AbortController().signal
const revision = { uri: 'file:///case', version: 1 }
describe('case inspection', () => {
  it('filters once, aggregates with missing counts and pages groups', async () => {
    const kase = await Case.parse(
      JSON.stringify({
        buses: [
          { class: 'Bus', number: 1, name: 'A', params: { kv: 230 } },
          { class: 'Bus', number: 2, name: 'A', params: { kv: 115 } },
          { class: 'Bus', number: 3, name: 'B' },
        ],
      }),
      catalog,
    )
    const query = {
      ...revision,
      from: 'Bus',
      where: [{ field: 'name', operator: 'equal' as const, value: 'A' }],
    }
    expect(await selectIds(kase, query, signal)).toEqual(['Bus/1', 'Bus/2'])
    expect(
      await aggregate(
        kase,
        { ...revision, from: 'Bus', fields: ['params.kv'], groupBy: 'name', limit: 1 },
        signal,
      ),
    ).toMatchObject({
      matched: 3,
      total: 2,
      nextOffset: 1,
      rows: [
        {
          group: 'A',
          count: 2,
          values: {
            'params.kv': { valid: 2, missing: 0, sum: 345, mean: 172.5, min: 115, max: 230 },
          },
        },
      ],
    })
    expect(
      await aggregate(
        kase,
        { ...revision, from: 'Bus', fields: ['params.kv'], groupBy: 'name', offset: 1 },
        signal,
      ),
    ).toMatchObject({
      rows: [{ group: 'B', values: { 'params.kv': { valid: 0, missing: 1, mean: null } } }],
    })
  })
  it('distinguishes electrical and control connections and traverses cycles without duplication', async () => {
    const kase = await Case.parse(
      JSON.stringify({
        buses: [
          { class: 'Bus', number: 1 },
          { class: 'Bus', number: 2 },
        ],
        signals: [{ signal_id: 1 }],
        devices: [
          { class: 'Branch', id: 'line', ports: { bus1: 1, bus2: 2 } },
          { class: 'BusFault', id: 'fault', ports: { bus: 2, control_signal: 1 } },
          { class: 'ConstantSignalSource', id: 'source', ports: { sr: 1 } },
        ],
      }),
      catalog,
    )
    const electrical = await neighborhood(
      kase,
      { ...revision, id: 'Bus/1', network: 'electrical', hops: 2 },
      signal,
    )
    expect(electrical).toMatchObject({
      nodes: 3,
      total: 2,
      rows: [
        { from: 'Branch/line', to: 'Bus/1' },
        { from: 'Branch/line', to: 'Bus/2' },
      ],
    })
    const control = await neighborhood(
      kase,
      { ...revision, id: 'BusFault/fault', network: 'control', hops: 10 },
      signal,
    )
    expect(control).toMatchObject({ nodes: 3, total: 2 })
    expect(control.rows.every((row) => row.to === 'Signal/1')).toBe(true)
    await expect(
      neighborhood(kase, { ...revision, id: 'Bus/99', network: 'electrical', hops: 2 }, signal),
    ).rejects.toThrow(/Unknown/)
  })
})
