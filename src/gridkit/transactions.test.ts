import { describe, expect, it } from 'vitest'

import catalogJson from '../../catalog.json'
import { Case } from './case.js'
import { catalogOf } from './definition.js'
import { placement } from './placement.js'
import { applyChanges, presentation, transaction } from './transactions.js'
const catalog = catalogOf(JSON.stringify(catalogJson))
const text =
  '{\r\n "buses":[{"class":"Bus","number":7,"params":{"kv":230.000}}],\r\n "signals":[{"signal_id":3,"name":"net"}],\r\n "devices":[{"class":"ConstantSignalSource","id":"source","ports":{"sr":3},"params":{"value":1.000}},{"class":"ConstantSignalSource","id":"other"},{"class":"BusFault","id":"load","ports":{"bus":7}},{"class":"BusFault","id":"unused","ports":{"bus":7}}]\r\n}'
const parse = (source = text) => Case.parse(source, catalog)
describe('document transactions', () => {
  it('places unlocated networks in the worker and respects authored geographic positions', async () => {
    const kase = await parse()
    const placed = await placement(kase, new AbortController().signal)
    expect(placed.Bus?.x.values.length).toBe(1)
    expect(placed.Bus?.y.values.length).toBe(1)
    const positioned = await parse(
      applyChanges(text, [
        transaction(kase, [{ kind: 'set', id: 'Bus/7', field: 'position', value: [-90, 40] }]),
      ]),
    )
    expect(await placement(positioned, new AbortController().signal)).toEqual({})
  })
  it('batches multiple changes in one record without reformatting untouched records or numeric tokens', async () => {
    const kase = await parse()
    const edits = transaction(kase, [
      { kind: 'set', id: 'Bus/7', field: 'name', value: '東京 😀' },
      { kind: 'set', id: 'Bus/7', field: 'position', value: [-90, 40] },
    ])
    const next = applyChanges(text, [edits])
    expect(next).toContain('"kv":230.000')
    expect(next).toContain('"value":1.000')
    expect(next).toContain('\r\n')
    expect(JSON.parse(next).buses[0]).toMatchObject({
      name: '東京 😀',
      extension: { longitude: -90, latitude: 40 },
    })
    await parse(next)
  })
  it('writes layout metadata as a minimal reversible source change', async () => {
    const kase = await parse()
    const edits = transaction(kase, [
      { kind: 'move', id: 'ConstantSignalSource/source', position: [120, 48] },
    ])
    const next = applyChanges(text, [edits])
    const after = await parse(next)
    const layout = presentation(after).ConstantSignalSource!
    expect(layout.x.values).toMatchObject({ kind: 'numeric', values: Float64Array.of(120) })
    expect(layout.y.values).toMatchObject({ kind: 'numeric', values: Float64Array.of(48) })
    expect(JSON.parse(next).devices[0].extension.diagram.position).toEqual([120, 48])
    expect(next).toContain('"value":1.000')
    expect(edits[0]!.length).toBeLessThan(120)
  })
  it('wires fan-out and refuses incompatible direction or a second output driver atomically', async () => {
    const kase = await parse()
    const next = applyChanges(text, [
      transaction(kase, [
        {
          kind: 'connect',
          from: { id: 'BusFault/load', field: 'ports.control_signal' },
          to: { id: 'ConstantSignalSource/source', field: 'ports.sr' },
        },
      ]),
    ])
    expect(JSON.parse(next).devices[2].ports.control_signal).toBe(3)
    const fan = await parse(next)
    expect(() =>
      transaction(fan, [
        {
          kind: 'connect',
          from: { id: 'ConstantSignalSource/other', field: 'ports.sr' },
          to: { id: 'Signal/3' },
        },
      ]),
    ).toThrow(/driver/)
    expect(() =>
      transaction(fan, [
        {
          kind: 'connect',
          from: { id: 'BusFault/load', field: 'ports.control_signal' },
          to: { id: 'BusFault/unused', field: 'ports.control_signal' },
        },
      ]),
    ).toThrow(/output to an input/)
    const disconnect = applyChanges(next, [
      transaction(fan, [
        { kind: 'connect', from: { id: 'BusFault/load', field: 'ports.control_signal' }, to: null },
      ]),
    ])
    expect(JSON.parse(disconnect).devices[2].ports.control_signal).toBeNull()
  })

  it('applies the same driver constraint to field edits and allows atomic driver reassignment', async () => {
    const kase = await parse()
    expect(() =>
      transaction(kase, [
        { kind: 'set', id: 'ConstantSignalSource/other', field: 'ports.sr', value: 'Signal/3' },
      ]),
    ).toThrow(/driver/)
    const next = applyChanges(text, [
      transaction(kase, [
        { kind: 'set', id: 'ConstantSignalSource/source', field: 'ports.sr', value: null },
        { kind: 'set', id: 'ConstantSignalSource/other', field: 'ports.sr', value: 'Signal/3' },
      ]),
    ])
    expect(JSON.parse(next).devices[1].ports.sr).toBe(3)
    await parse(next)
  })
  it('creates one stable signal ID when two unconnected ports are wired', async () => {
    const kase = await parse()
    const edits = transaction(kase, [
      {
        kind: 'connect',
        from: { id: 'ConstantSignalSource/other', field: 'ports.sr' },
        to: { id: 'BusFault/load', field: 'ports.control_signal' },
      },
    ])
    const next = applyChanges(text, [edits])
    const doc = JSON.parse(next)
    expect(doc.signals.at(-1).signal_id).toBe(4)
    expect(doc.devices[1].ports.sr).toBe(4)
    expect(doc.devices[2].ports.control_signal).toBe(4)
    expect(edits).toHaveLength(3)
    await parse(next)
  })
  it('guards referenced deletion and removes disjoint records without rewriting the array', async () => {
    const kase = await parse()
    expect(() => transaction(kase, [{ kind: 'remove', ids: ['Signal/3'] }])).toThrow(/references/)
    const next = applyChanges(text, [
      transaction(kase, [
        { kind: 'remove', ids: ['ConstantSignalSource/other', 'BusFault/unused'] },
      ]),
    ])
    expect(JSON.parse(next).devices.map((record: { id: string }) => record.id)).toEqual([
      'source',
      'load',
    ])
    expect(next).toContain('"value":1.000')
    await parse(next)
  })
  it('applies sequential UTF-16 document delta groups against their own preceding versions', () => {
    const initial = '東京 😀 230.000'
    const result = applyChanges(initial, [
      [{ offset: 6, length: 7, text: '115.0' }],
      [{ offset: 0, length: 2, text: 'NY' }],
    ])
    expect(result).toBe('NY 😀 115.0')
  })
})
