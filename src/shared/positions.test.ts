import { describe, expect, it } from 'vitest'

import { Case } from '../gridkit/case.js'
import { catalog } from '../gridkit/definition.js'
import { applyChanges, transaction } from '../gridkit/transactions.js'
import { located } from './positions.js'
import { networkOf } from './schema.js'

const text = '{"buses":[{"class":"Bus","number":7,"params":{"kv":230.0}}]}'

describe('network positions', () => {
  it('leaves a case without positions to the layout', async () => {
    const kase = await Case.parse(text, catalog)
    expect(located(kase.data)).toBe(false)
  })
  it('places a case that gives its buses longitude and latitude by them', async () => {
    const kase = await Case.parse(text, catalog)
    const placed = await Case.parse(
      applyChanges(text, [
        transaction(kase, [
          { kind: 'set', id: 'Bus/7', field: 'extension.longitude', value: -90 },
          { kind: 'set', id: 'Bus/7', field: 'extension.latitude', value: 40 },
        ]),
      ]),
      catalog,
    )
    expect(located(placed.data)).toBe(true)
    expect(networkOf(placed.schema).geographic).toBe(true)
  })
})
