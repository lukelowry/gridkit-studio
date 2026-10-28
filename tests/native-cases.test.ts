import { readdir, readFile } from 'node:fs/promises'

import { expect, it } from 'vitest'

import { Case } from '../src/gridkit/case.js'
import { catalog } from '../src/gridkit/definition.js'
import { apply, diagnose, sourceRange } from '../src/gridkit/edits.js'
import { transaction } from '../src/gridkit/transactions.js'
import { LABEL } from '../src/shared/document.js'

it('opens every bundled case with native identities and lazy scalar projections', async () => {
  for (const file of await readdir('cases')) {
    if (!file.endsWith('.case.json')) continue
    const kase = await Case.parse(await readFile(`cases/${file}`, 'utf8'), catalog)
    const projected = kase.projected()
    expect(projected.key).toBe(kase.version)
    for (const [name, table] of projected.tables) {
      const parsed = kase.table(name)
      expect(table.ids.length).toBe(parsed.records.length)
      if (!table.ids.length) continue
      const entity = { table: name, id: table.ids[0]! }
      expect(kase.locate(entity)?.row).toBe(0)
      expect(table.read(LABEL, 0, 1)).toEqual([String(entity.id)])
    }
  }
}, 120_000)

it('preserves punctuation and reuses untouched parser chunks after a scalar edit', async () => {
  const text = JSON.stringify({
    buses: [{ number: 42, class: 'Bus', params: { kv: 100 } }],
    signals: [],
    devices: [{ id: 'a/b:[]', class: 'Branch', ports: { bus1: 42, bus2: 42 } }],
  })
  const first = await Case.parse(text, catalog)
  const second = await Case.revise(first, text.replace('100', '230'))
  expect(second.locate({ table: 'Branch', id: 'a/b:[]' })?.row).toBe(0)
  expect(second.table('Branch').ids).toBe(first.table('Branch').ids)
  expect(second.projected().tables.get('Branch')!.read('ports.bus1', 0, 1)).toEqual({
    reference: 'Bus',
    ids: [42],
  })
  expect(second.projected().tables.get('Bus')!.read('params.kv', 0, 1)).toEqual(
    Float64Array.of(230),
  )
})

it('commits scalar, position, connection, and removal edits through source spans', async () => {
  const text = JSON.stringify({
    buses: [{ number: 42, class: 'Bus', params: { kv: 100 } }],
    signals: [{ signal_id: 1, name: 'existing' }],
    devices: [
      { id: 'a/b', class: 'ConstantSignalSource', ports: { sr: 1 }, params: { k: 1 } },
      { id: 'fault:[]', class: 'BusFault', ports: { bus: 42 } },
    ],
  })
  const kase = await Case.parse(text, catalog)
  const changed = apply(
    text,
    transaction(kase, [
      { kind: 'set', entity: { table: 'Bus', id: 42 }, field: 'params.kv', value: 230 },
      { kind: 'move', entity: { table: 'BusFault', id: 'fault:[]' }, position: [5, 6] },
      {
        kind: 'connect',
        from: { table: 'ConstantSignalSource', id: 'a/b', field: 'ports.sr' },
        to: { table: 'BusFault', id: 'fault:[]', field: 'ports.control_signal' },
      },
    ]),
  )
  const edited = await Case.parse(changed, catalog)
  const json = JSON.parse(changed)
  expect(json.buses[0].params.kv).toBe(230)
  expect(json.devices[1].ports.control_signal).toBe(1)
  expect(json.devices[1].extension.diagram.position).toEqual([5, 6])
  expect(sourceRange(edited, { table: 'BusFault', id: 'fault:[]' }).length).toBeGreaterThan(1)
  expect(() =>
    transaction(edited, [{ kind: 'remove', entities: [{ table: 'Signal', id: 1 }] }]),
  ).toThrow('still references')
  const removed = apply(
    changed,
    transaction(edited, [
      {
        kind: 'remove',
        entities: [
          { table: 'ConstantSignalSource', id: 'a/b' },
          { table: 'BusFault', id: 'fault:[]' },
          { table: 'Signal', id: 1 },
        ],
      },
    ]),
  )
  expect(JSON.parse(removed).devices).toEqual([])
  expect(await diagnose(await Case.parse(removed, catalog), AbortSignal.any([]))).toEqual(
    expect.any(Array),
  )
})
