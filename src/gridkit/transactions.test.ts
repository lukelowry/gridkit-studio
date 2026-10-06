import { describe, expect, it } from 'vitest'

import { Case } from './case.js'
import { catalog } from './definition.js'
import { applyChanges, presentation, transaction } from './transactions.js'
const text =
  '{\r\n "buses":[{"class":"Bus","number":7,"params":{"kv":230.000}}],\r\n "signals":[{"signal_id":3,"name":"net"}],\r\n "devices":[{"class":"ConstantSignalSource","id":"source","ports":{"sr":3},"params":{"value":1.000}},{"class":"ConstantSignalSource","id":"other"},{"class":"BusFault","id":"load","ports":{"bus":7}},{"class":"BusFault","id":"unused","ports":{"bus":7}}]\r\n}'
const parse = (source = text) => Case.parse(source, catalog)
describe('document transactions', () => {
  it('creates forward references, redirects an existing port, removes the old bus and edits values atomically', async () => {
    const kase = await parse()
    const next = applyChanges(text, [
      transaction(kase, [
        {
          kind: 'add',
          type: 'Branch',
          key: 'tie',
          fields: { 'ports.bus1': 'Bus/8', 'ports.bus2': 'Bus/9', 'params.X': 0.1 },
        },
        { kind: 'add', type: 'Bus', key: 8, fields: { 'params.kv': 230 } },
        { kind: 'add', type: 'Bus', key: 9, fields: {} },
        { kind: 'set', id: 'BusFault/load', field: 'ports.bus', value: 'Bus/8' },
        { kind: 'set', id: 'BusFault/unused', field: 'ports.bus', value: 'Bus/9' },
        { kind: 'remove', ids: ['Bus/7'] },
        { kind: 'set', id: 'Branch/tie', field: 'params.X', value: 0.2 },
        { kind: 'move', id: 'BusFault/load', position: [10, 20] },
      ]),
    ])
    const final = await parse(next)
    expect(final.locate('Bus/7')).toBeNull()
    expect(final.locate('Branch/tie')).toBeDefined()
    expect(JSON.parse(next).buses.map((bus: { number: number }) => bus.number)).toEqual([8, 9])
    expect(next).toContain('"value":1.000')
  })
  it('permits a new signal driver after removing the old one in the same batch', async () => {
    const kase = await parse()
    const next = applyChanges(text, [
      transaction(kase, [
        {
          kind: 'add',
          type: 'ConstantSignalSource',
          key: 'replacement',
          fields: { 'ports.sr': 'Signal/3' },
        },
        { kind: 'remove', ids: ['ConstantSignalSource/source'] },
        {
          kind: 'connect',
          from: { id: 'BusFault/load', field: 'ports.control_signal' },
          to: { id: 'ConstantSignalSource/replacement', field: 'ports.sr' },
        },
      ]),
    ])
    const final = await parse(next)
    expect(() => final.checkSignals()).not.toThrow()
    expect(
      JSON.parse(next).devices.find((device: { id: string }) => device.id === 'load').ports
        .control_signal,
    ).toBe(3)
  })
  it('batches multiple changes in one record without reformatting untouched records or numeric tokens', async () => {
    const kase = await parse()
    const edits = transaction(kase, [
      { kind: 'set', id: 'Bus/7', field: 'name', value: '東京 😀' },
      { kind: 'set', id: 'Bus/7', field: 'extension.longitude', value: -90 },
      { kind: 'set', id: 'Bus/7', field: 'extension.latitude', value: 40 },
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
