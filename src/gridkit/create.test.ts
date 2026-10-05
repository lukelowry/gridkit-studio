import { describe, expect, it } from 'vitest'

import { Case, catalog, diagnose, transaction } from './index.js'
import { applyChanges } from './transactions.js'

describe('component creation', () => {
  it.each([
    '{}',
    '{"name":"東京","buses":[],"devices":[]}\r\n',
    '{"buses":[{"class":"Bus","number":1,"params":{"kv":230.000}}]}',
  ])(
    'adds forward-referencing buses and branches without rewriting existing source: %s',
    async (source) => {
      const kase = await Case.parse(source, catalog)
      const edits = transaction(kase, [
        {
          kind: 'add',
          type: 'Branch',
          key: 'new',
          fields: { 'ports.bus1': 'Bus/2', 'ports.bus2': 'Bus/3', 'params.R': 0, 'params.X': 0.1 },
        },
        { kind: 'add', type: 'Bus', key: 2, fields: { name: 'New A', 'params.kv': 230 } },
        { kind: 'add', type: 'Bus', key: 3, fields: { name: 'New B' } },
      ])
      expect(edits.every((edit) => edit.length === 0)).toBe(true)
      const next = applyChanges(source, [edits])
      const parsed = await Case.parse(next, catalog)
      expect(parsed.locate('Branch/new')).toBeDefined()
      expect(diagnose(parsed)).toEqual([])
      expect(JSON.parse(next).devices[0].ports).toEqual({ bus1: 2, bus2: 3 })
      expect(next).toMatch(/"R":\s*0\.0/)
      if (source.includes('230.000')) expect(next).toContain('230.000')
    },
  )
  it('validates identities, fields, required ports, references and signal drivers before any edit', async () => {
    const kase = await Case.parse('{"buses":[{"class":"Bus","number":1}]}', catalog)
    expect(() => transaction(kase, [{ kind: 'add', type: 'Bus', key: 1, fields: {} }])).toThrow(
      /already exists/,
    )
    expect(() => transaction(kase, [{ kind: 'add', type: 'Bus', key: -1, fields: {} }])).toThrow(
      /uint32/,
    )
    expect(() =>
      transaction(kase, [{ kind: 'add', type: 'BusFault', key: 'fault', fields: {} }]),
    ).toThrow(/requires ports.bus/)
    expect(() =>
      transaction(kase, [
        { kind: 'add', type: 'BusFault', key: 'fault', fields: { 'ports.bus': 'Bus/99' } },
      ]),
    ).toThrow()
    expect(() =>
      transaction(kase, [{ kind: 'add', type: 'Bus', key: 2, fields: { Vm: 1 } }]),
    ).toThrow(/non-writable/)
    expect(() =>
      transaction(kase, [
        { kind: 'add', type: 'Signal', key: 1, fields: {} },
        { kind: 'add', type: 'ConstantSignalSource', key: 'A', fields: { 'ports.sr': 'Signal/1' } },
        { kind: 'add', type: 'ConstantSignalSource', key: 'B', fields: { 'ports.sr': 'Signal/1' } },
      ]),
    ).toThrow(/driver/)
  })
})
