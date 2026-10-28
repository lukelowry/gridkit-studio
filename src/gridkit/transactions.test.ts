import { describe, expect, it } from 'vitest'

import { DIAGRAM_POSITION } from '../shared/document.js'
import { Case } from './case.js'
import { catalog } from './definition.js'
import { applyChanges, delivered, transaction } from './transactions.js'
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
          fields: { 'ports.bus1': 8, 'ports.bus2': 9, 'params.X': 0.1 },
        },
        { kind: 'add', type: 'Bus', key: 8, fields: { 'params.kv': 230 } },
        { kind: 'add', type: 'Bus', key: 9, fields: {} },
        { kind: 'set', entity: { table: 'BusFault', id: 'load' }, field: 'ports.bus', value: 8 },
        { kind: 'set', entity: { table: 'BusFault', id: 'unused' }, field: 'ports.bus', value: 9 },
        { kind: 'remove', entities: [{ table: 'Bus', id: 7 }] },
        { kind: 'set', entity: { table: 'Branch', id: 'tie' }, field: 'params.X', value: 0.2 },
        { kind: 'move', entity: { table: 'BusFault', id: 'load' }, position: [10, 20] },
      ]),
    ])
    const final = await parse(next)
    expect(final.locate({ table: 'Bus', id: 7 })).toBeNull()
    expect(final.locate({ table: 'Branch', id: 'tie' })).toBeDefined()
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
          fields: { 'ports.sr': 3 },
        },
        { kind: 'remove', entities: [{ table: 'ConstantSignalSource', id: 'source' }] },
        {
          kind: 'connect',
          from: { table: 'BusFault', id: 'load', field: 'ports.control_signal' },
          to: { table: 'ConstantSignalSource', id: 'replacement', field: 'ports.sr' },
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
      { kind: 'set', entity: { table: 'Bus', id: 7 }, field: 'name', value: '東京 😀' },
      { kind: 'set', entity: { table: 'Bus', id: 7 }, field: 'extension.longitude', value: -90 },
      { kind: 'set', entity: { table: 'Bus', id: 7 }, field: 'extension.latitude', value: 40 },
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
      {
        kind: 'move',
        entity: { table: 'ConstantSignalSource', id: 'source' },
        position: [120, 48],
      },
    ])
    const next = applyChanges(text, [edits])
    const after = await parse(next)
    const table = after.projected().tables.get('ConstantSignalSource')!
    expect(table.read(DIAGRAM_POSITION[0], 0, 1)).toEqual(Float64Array.of(120))
    expect(table.read(DIAGRAM_POSITION[1], 0, 1)).toEqual(Float64Array.of(48))
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
          from: { table: 'BusFault', id: 'load', field: 'ports.control_signal' },
          to: { table: 'ConstantSignalSource', id: 'source', field: 'ports.sr' },
        },
      ]),
    ])
    expect(JSON.parse(next).devices[2].ports.control_signal).toBe(3)
    const fan = await parse(next)
    expect(() =>
      transaction(fan, [
        {
          kind: 'connect',
          from: { table: 'ConstantSignalSource', id: 'other', field: 'ports.sr' },
          to: { table: 'Signal', id: 3 },
        },
      ]),
    ).toThrow(/driver/)
    expect(() =>
      transaction(fan, [
        {
          kind: 'connect',
          from: { table: 'BusFault', id: 'load', field: 'ports.control_signal' },
          to: { table: 'BusFault', id: 'unused', field: 'ports.control_signal' },
        },
      ]),
    ).toThrow(/output to an input/)
    const disconnect = applyChanges(next, [
      transaction(fan, [
        {
          kind: 'connect',
          from: { table: 'BusFault', id: 'load', field: 'ports.control_signal' },
          to: null,
        },
      ]),
    ])
    expect(JSON.parse(disconnect).devices[2].ports.control_signal).toBeNull()
  })

  it('applies the same driver constraint to field edits and allows atomic driver reassignment', async () => {
    const kase = await parse()
    expect(() =>
      transaction(kase, [
        {
          kind: 'set',
          entity: { table: 'ConstantSignalSource', id: 'other' },
          field: 'ports.sr',
          value: 3,
        },
      ]),
    ).toThrow(/driver/)
    const next = applyChanges(text, [
      transaction(kase, [
        {
          kind: 'set',
          entity: { table: 'ConstantSignalSource', id: 'source' },
          field: 'ports.sr',
          value: null,
        },
        {
          kind: 'set',
          entity: { table: 'ConstantSignalSource', id: 'other' },
          field: 'ports.sr',
          value: 3,
        },
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
        from: { table: 'ConstantSignalSource', id: 'other', field: 'ports.sr' },
        to: { table: 'BusFault', id: 'load', field: 'ports.control_signal' },
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
    expect(() =>
      transaction(kase, [{ kind: 'remove', entities: [{ table: 'Signal', id: 3 }] }]),
    ).toThrow(/references/)
    const next = applyChanges(text, [
      transaction(kase, [
        {
          kind: 'remove',
          entities: [
            { table: 'ConstantSignalSource', id: 'other' },
            { table: 'BusFault', id: 'unused' },
          ],
        },
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

  it('delivers edits within lines as they are, and several of lines as one to the end', () => {
    const lines = 'one\ntwo\r\nthree\nfour'
    const within = [
      { offset: 9, length: 5, text: 'THREE' },
      { offset: 0, length: 3, text: 'ONE' },
    ]
    expect(delivered(lines, within)).toEqual([within[1], within[0]])
    // One edit that takes a line away moves the lines below it once.
    const one = [{ offset: 4, length: 5, text: 'two ' }]
    expect(delivered(lines, one)).toEqual(one)
    // A line break the edit takes away counts as one it writes, a CRLF as much as an LF.
    const several = [
      { offset: 15, length: 0, text: 'and\n' },
      { offset: 7, length: 2, text: ' ' },
      { offset: 1, length: 2, text: 'NE' },
    ]
    const after = applyChanges(lines, [several])
    expect(after).toBe('oNE\ntwo three\nand\nfour')
    expect(delivered(lines, several)).toEqual([
      { offset: 1, length: lines.length - 1, text: after.slice(1) },
    ])
  })

  it('delivers edits within lines as one to the end once VS Code would make them one', () => {
    const list = Array.from({ length: 2000 }, (_, n) => `{"n":${n}}`).join(',\n')
    const marks = [...list.matchAll(/}/g)].map(({ index }) => ({
      offset: index,
      length: 0,
      text: ',"mon":[]',
    }))
    const [one] = delivered(list, marks)
    expect(one).toMatchObject({ offset: marks[0]!.offset, length: list.length - marks[0]!.offset })
    expect(applyChanges(list, [[one!]])).toBe(applyChanges(list, [marks]))
    // Fewer go as they are.
    expect(delivered(list, marks.slice(0, 10))).toEqual(marks.slice(0, 10))
  })
})
