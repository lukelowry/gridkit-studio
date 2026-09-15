import { readFileSync } from 'node:fs'

import type { ClassData, Column, Model } from '@latkit/model'
import { describe, expect, it } from 'vitest'

import { parse as parseCase } from '../src/gridkit/parse.js'
const parse = (bytes: Uint8Array) => parseCase(bytes).model

import { caseBytes } from './support/case.js'

const rawBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

const TWO_AREA = readFileSync(new URL('./fixtures/TwoArea.case.json', import.meta.url))

const HYGOV = {
  class: 'Hygov',
  ports: { speed: 1, pmech: 7, pref: 8, paux: 9 },
  id: 'DV6',
  params: {
    Trate: 80.0,
    Rperm: 0.05,
    Rtemp: 0.35,
    Tr: 5.0,
    Tf: 0.05,
    Tg: 0.5,
    Velm: 0.2,
    Gmax: 0.98,
    Gmin: 0.02,
    Tw: 1.2,
    At: 1.1,
    Dturb: 0.4,
    Qnl: 0.08,
    Tn: 0.7,
    Tnp: 1.4,
    db1: 0.01,
    db2: 0.02,
    Hdam: 1.05,
    Gv0: 0.0,
    Gv1: 0.2,
    Gv2: 0.4,
    Gv3: 0.6,
    Gv4: 0.8,
    Gv5: 1.0,
    Pgv0: 0.0,
    Pgv1: 0.15,
    Pgv2: 0.42,
    Pgv3: 0.66,
    Pgv4: 0.85,
    Pgv5: 1.0,
  },
  mon: ['pmech', 'filter', 'desiredgate', 'gate', 'flow', 'head'],
} as const

const spec = (model: Model, id: string) => model.classes.find((cls) => cls.id === id)!
const column = (data: ClassData, id: string): Column => data.columns.find((c) => c.id === id)!
const columnInfo = (data: ClassData, id: string) => {
  const c = column(data, id)
  return { kind: c.kind, ...(c.group !== undefined && { group: c.group }) }
}

describe('case parsing', () => {
  it('opens the solver fixture and loads its class data', async () => {
    const bytes = readFileSync(new URL('./fixtures/solver/two-bus.case.json', import.meta.url))
    const model = parse(bytes)
    expect(model.topology.vertexCount).toBe(2)
    expect(model.topology.edges).toHaveLength(2)
    expect((await model.load('bus')).labels).toEqual(['0', '1'])
    expect(await model.bytes()).toBe(bytes)
  })

  it('rejects malformed JSON and reports missing format fields', () => {
    expect(() => parse(new TextEncoder().encode('{'))).toThrow()
    expect(() => parse(new TextEncoder().encode('{}'))).toThrow('$.header is required')
  })

  it('rejects unsupported format versions', () => {
    expect(() => parse(caseBytes({ header: { format_version: 0.1 } }))).toThrow(
      '$.header.format_version must be 0.2',
    )
  })

  it('parses a large generated topology without external model assets', async () => {
    const count = 7_000
    const bytes = caseBytes({
      buses: Array.from({ length: count }, (_, number) => ({
        number,
        extension: { longitude: -100 + number / 10_000, latitude: 40 },
      })),
      devices: Array.from({ length: count - 1 }, (_, index) => ({
        class: 'Branch',
        id: String(index),
        ports: { bus1: index, bus2: index + 1 },
      })),
    })
    const model = parse(bytes)
    expect(model.topology.vertexCount).toBe(count)
    expect(model.topology.edges).toHaveLength((count - 1) * 2)
    expect(model.topology.vertexCoords).toHaveLength(count * 2)
    expect((await model.load('bus')).labels).toHaveLength(count)
  })

  it('retains the canonical vendor source', async () => {
    const model = parse(TWO_AREA)
    expect(model.vendor).toBe('gridkit')
    expect(await model.bytes()).toBe(TWO_AREA)
    const decoded = JSON.parse(new TextDecoder().decode(await model.bytes()))
    expect(decoded.header.case_name).toBe('TwoArea')
    expect(decoded.buses).toHaveLength(10)
    expect(decoded.params).toEqual({ freq_base: 60, va_base: 100000000 })
  })

  it('surfaces extension.xfmr as a flag column on the branch class', async () => {
    const model = parse(TWO_AREA)
    const branch = await model.load('branch')
    const xfmr = column(branch, 'extension.xfmr')
    expect(xfmr).toMatchObject({ kind: 'flag', group: 'Extension' })
    expect(xfmr.values.length).toBe(model.topology.edges.length / 2)
    expect((xfmr.values as Uint8Array).reduce((sum, flag) => sum + flag, 0)).toBe(4)
  })

  it('carries no xfmr column when no branch declares one', async () => {
    const model = parse(
      caseBytes({
        buses: [{ number: 1 }, { number: 2 }],
        devices: [{ class: 'Branch', ports: { bus1: 1, bus2: 2 }, params: { R: 0.0, X: 0.1 } }],
      }),
    )
    expect((await model.load('branch')).columns.map((c) => c.id)).not.toContain('extension.xfmr')
  })

  it('reads the case name from header.case_name', () => {
    const model = parse(TWO_AREA)
    expect(model.name).toBe('TwoArea')
  })

  it('derives a deterministic case id', () => {
    const a = parse(TWO_AREA)
    const b = parse(readFileSync(new URL('./fixtures/TwoArea.case.json', import.meta.url)))
    expect(a.id).toMatch(/^gridkit:[0-9a-f]{8}$/)
    expect(a.id).toBe(b.id) // same bytes → same id
  })

  it('builds the metadata with canonical keys', () => {
    const { meta } = parse(TWO_AREA)
    expect(meta).toEqual({
      formatVersion: 0.2,
      formatRevision: 0,
      description: '',
      comments: '',
      frequencyBaseHz: 60,
      powerBaseVa: 100000000,
    })
  })

  it('rejects unsupported roots and bus aliases', () => {
    expect(() =>
      parse(
        rawBytes({
          header: { case_name: 'old', freq_base: 60, va_base: 100000000 },
          buses: [],
          devices: [],
        }),
      ),
    ).toThrow('format_version is required')

    expect(() =>
      parse(
        rawBytes({
          header: {
            format_version: 0.2,
            format_revision: 0,
            case_name: 'old',
            case_description: '',
            case_comments: '',
          },
          params: { freq_base: 60, va_base: 100000000 },
          buses: [{ number: 1, class: 'bus', name: '1', params: {} }],
          devices: [],
        }),
      ),
    ).toThrow('must be exactly Bus or BusInfinite')
  })
})

describe('topology', () => {
  it('derives buses → vertices and Branch devices → edges (bus row indices)', () => {
    const { topology } = parse(TWO_AREA)
    expect(topology.vertexCount).toBe(10)
    expect(topology.edges.length).toBe(30) // 15 edges
    expect(Array.from(topology.edges.slice(0, 8))).toEqual([0, 4, 1, 5, 2, 8, 3, 9])
    expect(topology.vertexCoords).toBeUndefined() // TwoArea has no extension coords
    expect(topology.coordinateSpace).toBe('cartesian')
    expect(topology.polylineStart.length).toBe(16) // edges + 1
    expect(Array.from(topology.polylineStart)).toEqual(new Array(16).fill(0))
    expect(topology.polylinePoints).toBeUndefined()
  })

  it('packs vertex coords (all-or-nothing) and polyline CSR from extensions', () => {
    const { topology } = parse(
      caseBytes({
        header: { case_name: 'geo' },
        buses: [
          { number: 10, class: 'Bus', extension: { longitude: -100.5, latitude: 40.25 } },
          { number: 20, class: 'Bus', extension: { longitude: -99, latitude: 41 } },
          { number: 30, class: 'Bus', extension: { longitude: -98, latitude: 42 } },
        ],
        devices: [
          { class: 'LoadZ', id: 'LD1', ports: { bus: 10 } },
          {
            class: 'Branch',
            id: 'L1',
            ports: { bus1: 10, bus2: 20 },
            extension: {
              polyline: [
                [-100, 40.5],
                [-99.5, 40.75],
              ],
            },
          },
          { class: 'Branch', id: 'L2', ports: { bus1: 20, bus2: 30 } },
        ],
      }),
    )
    expect(topology.vertexCount).toBe(3)
    expect(Array.from(topology.edges)).toEqual([0, 1, 1, 2]) // Load is not an edge
    expect(Array.from(topology.vertexCoords!)).toEqual([-100.5, 40.25, -99, 41, -98, 42])
    expect(topology.coordinateSpace).toBe('geographic')
    expect(Array.from(topology.polylineStart)).toEqual([0, 2, 2])
    expect(Array.from(topology.polylinePoints!)).toEqual([-100, 40.5, -99.5, 40.75])
  })

  it('omits all coords when any bus lacks them', () => {
    const { topology } = parse(
      caseBytes({
        header: { case_name: 'sparse' },
        buses: [{ number: 1, extension: { longitude: -100, latitude: 40 } }, { number: 2 }],
        devices: [],
      }),
    )
    expect(topology.vertexCoords).toBeUndefined()
    expect(topology.coordinateSpace).toBe('cartesian')
  })

  it('rejects duplicate bus numbers and branches to unknown buses', () => {
    expect(() =>
      parse(caseBytes({ header: {}, buses: [{ number: 1 }, { number: 1 }], devices: [] })),
    ).toThrow(/duplicates bus 1/)
    expect(() =>
      parse(
        caseBytes({
          header: {},
          buses: [{ number: 1 }],
          devices: [{ class: 'Branch', ports: { bus1: 1, bus2: 99 } }],
        }),
      ),
    ).toThrow(/unknown bus 99/)
  })
})

describe('classes', () => {
  it('enumerates element classes: bus (vertex owner), Branch (edge owner), devices anchored to buses', () => {
    const model = parse(TWO_AREA)
    expect(model.classes.map((c) => c.id)).toEqual([
      'bus',
      'signal',
      'branch',
      'load_zip',
      'genrou',
      'tgov1',
      'ieeet1',
    ])
    expect(model.classes.map((c) => c.label)).toEqual([
      'Bus',
      'Signal',
      'Branch',
      'LoadZIP',
      'GENROU',
      'TGOV1',
      'IEEET1',
    ])
    expect(model.classes.map((c) => c.count)).toEqual([10, 12, 15, 2, 4, 4, 4])
    expect(model.owners).toEqual({ vertex: 'bus', edge: 'branch' })
    expect(spec(model, 'bus').anchor).toBeUndefined()
    expect(spec(model, 'branch').anchor).toBeUndefined()
    expect(spec(model, 'signal').anchor).toBeUndefined()
    expect(spec(model, 'genrou').anchor?.kind).toBe('vertex')
    expect(spec(model, 'genrou').anchor?.index.length).toBe(4)
  })

  it('groups columns by the block a key lives in', async () => {
    const model = parse(TWO_AREA)
    const bus = await model.load('bus')
    expect(columnInfo(bus, 'top.number')).toEqual({ kind: 'number' })
    expect(columnInfo(bus, 'init.Vr')).toEqual({ kind: 'number', group: 'Initial state' })
    expect(columnInfo(bus, 'params.kv')).toEqual({ kind: 'number', group: 'Parameters' })
    expect(columnInfo(bus, 'top.name')).toEqual({ kind: 'text' })

    const genrou = await model.load('genrou')
    expect(columnInfo(genrou, 'top.id')).toEqual({ kind: 'text' })
    expect(columnInfo(genrou, 'ports.bus')).toEqual({ kind: 'number', group: 'Ports' })
    expect(columnInfo(genrou, 'params.H')).toEqual({ kind: 'number', group: 'Parameters' })

    const branch = await model.load('branch')
    expect(columnInfo(branch, 'ports.bus1')).toEqual({ kind: 'number', group: 'Ports' })
    expect(columnInfo(branch, 'params.R')).toEqual({ kind: 'number', group: 'Parameters' })
  })

  it('keeps readable extension labels with qualified identities', async () => {
    const model = parse(
      caseBytes({
        header: { case_name: 'ext' },
        buses: [
          { number: 1, class: 'Bus', name: 'A', extension: { longitude: -100, latitude: 40 } },
        ],
        devices: [],
      }),
    )
    const bus = await model.load('bus')
    expect(columnInfo(bus, 'extension.longitude')).toEqual({ kind: 'number', group: 'Extension' })
    expect(columnInfo(bus, 'extension.latitude')).toEqual({ kind: 'number', group: 'Extension' })
  })

  it('discovers bus parameter and initial-value names from the case', async () => {
    const model = parse(
      caseBytes({
        buses: [
          {
            number: 1,
            class: 'Bus',
            name: 'A',
            init: { Vr: 1, futureState: 0.5 },
            params: { kv: 115, futureLimit: 2, enabled: true },
          },
        ],
      }),
    )
    const bus = await model.load('bus')
    expect(columnInfo(bus, 'init.futureState')).toEqual({ kind: 'number', group: 'Initial state' })
    expect(columnInfo(bus, 'params.futureLimit')).toEqual({ kind: 'number', group: 'Parameters' })
    expect(columnInfo(bus, 'params.enabled')).toEqual({ kind: 'flag', group: 'Parameters' })
    expect((column(bus, 'init.futureState').values as Float64Array)[0]).toBe(0.5)
    expect((column(bus, 'params.enabled').values as Uint8Array)[0]).toBe(1)
  })

  it('uses one stable bus axis regardless of raw bus-class order', async () => {
    for (const buses of [
      [
        { number: 1, class: 'Bus', name: 'A' },
        { number: 2, class: 'BusInfinite', name: 'B' },
      ],
      [
        { number: 1, class: 'BusInfinite', name: 'A' },
        { number: 2, class: 'Bus', name: 'B' },
      ],
    ]) {
      const model = parse(caseBytes({ buses }))
      expect(model.owners.vertex).toBe('bus')
      expect(spec(model, 'bus').count).toBe(2)
      expect((column(await model.load('bus'), 'top.class').values as string[])[0]).toBe(
        buses[0]!.class,
      )
    }
  })

  it('surfaces signals as an unplaced inspection class', async () => {
    const model = parse(caseBytes({ signals: [{ signal_id: 4, name: 'speed deviation' }] }))
    expect(spec(model, 'signal').anchor).toBeUndefined()
    const signal = await model.load('signal')
    expect(signal.labels).toEqual(['4'])
    expect(signal.columns.map((c) => [c.id, c.kind])).toEqual([
      ['top.signal_id', 'number'],
      ['top.name', 'text'],
    ])
    expect((column(signal, 'top.name').values as string[])[0]).toBe('speed deviation')
  })

  it('discovers HYGOV ports, parameters, and signals from GridKit common device data', async () => {
    const model = parse(caseBytes({ devices: [HYGOV] }))
    const hygov = spec(model, 'hygov')

    expect(hygov.label).toBe('HYGOV')
    expect(hygov.signals.map((s) => [s.id, s.recorded])).toEqual(HYGOV.mon.map((id) => [id, true]))
    const data = await model.load('hygov')
    expect(columnInfo(data, 'ports.speed')).toEqual({ kind: 'number', group: 'Ports' })
    expect(columnInfo(data, 'ports.pmech')).toEqual({ kind: 'number', group: 'Ports' })
    expect(data.columns.filter((c) => c.group === 'Parameters').map((c) => c.id)).toEqual(
      Object.keys(HYGOV.params).map((key) => `params.${key}`),
    )
  })

  it('accepts future device classes and surfaces their common-envelope data without a registry entry', async () => {
    const model = parse(
      caseBytes({
        devices: [
          {
            class: 'FutureGovernor',
            id: 'FG1',
            ports: { input: 1, output: 2 },
            init: { state: 0.25 },
            params: { gain: 4.0, enabled: true },
            mon: ['output'],
            source: 'generated',
          },
        ],
      }),
    )
    const cls = spec(model, 'future_governor')
    expect(cls.label).toBe('FutureGovernor')
    expect(cls.signals).toEqual([{ id: 'output', label: 'output', unit: '', recorded: true }])
    const data = await model.load(cls.id)
    expect(columnInfo(data, 'ports.input')).toEqual({ kind: 'number', group: 'Ports' })
    expect(columnInfo(data, 'init.state')).toEqual({ kind: 'number', group: 'Initial state' })
    expect(columnInfo(data, 'params.gain')).toEqual({ kind: 'number', group: 'Parameters' })
    expect(columnInfo(data, 'top.source')).toEqual({ kind: 'text' })
    expect((column(data, 'init.state').values as Float64Array)[0]).toBe(0.25)
    expect((column(data, 'top.source').values as string[])[0]).toBe('generated')
  })

  it('displays a recorded mon in the catalog spelling whatever casing the case uses, for every class', () => {
    const model = parse(
      caseBytes({
        buses: [
          { number: 1, class: 'Bus', name: 'A', mon: ['vm', 'VA'] },
          { number: 2, class: 'BusInfinite', name: 'B', mon: ['VR'] },
        ],
        devices: [
          { class: 'Genrou', id: 'G1', ports: { bus: 1 }, mon: ['SPEED', 'Omega'] },
          { class: 'Genrou', id: 'G2', ports: { bus: 1 }, mon: ['speed', 'novel'] },
        ],
      }),
    )
    const recorded = (id: string) =>
      spec(model, id)
        .signals.filter((signal) => signal.recorded)
        .map((signal) => signal.id)
    expect(recorded('bus')).toEqual(['Vr', 'Vm', 'Va'])
    expect(recorded('genrou')).toEqual(['omega', 'speed', 'novel'])
    expect(spec(model, 'genrou').signals.map((signal) => signal.id)).toEqual([
      'ir',
      'ii',
      'p',
      'q',
      'delta',
      'omega',
      'speed',
      'novel',
    ])
  })

  it('drops a key whose values are nested, keeps mixed scalars as text', async () => {
    const model = parse(
      caseBytes({
        devices: [
          { class: 'Thing', id: 'a', extension: { shape: [1, 2], tag: 'x' } },
          { class: 'Thing', id: 'b', extension: { tag: 3 } },
        ],
      }),
    )
    const data = await model.load('thing')
    expect(data.columns.map((c) => c.id)).not.toContain('extension.shape')
    expect(column(data, 'extension.tag')).toMatchObject({ kind: 'text', values: ['x', '3'] })
  })

  it('scopes device identities by exact class and rejects colliding class ids', () => {
    const model = parse(
      caseBytes({
        devices: [
          { class: 'FutureGovernor', id: 'shared' },
          { class: 'FutureExciter', id: 'shared' },
        ],
      }),
    )
    expect(model.classes.map((cls) => cls.id)).toEqual(['future_governor', 'future_exciter'])

    expect(() =>
      parse(
        caseBytes({
          devices: [
            { class: 'FutureGovernor', id: 'duplicate' },
            { class: 'FutureGovernor', id: 'duplicate' },
          ],
        }),
      ),
    ).toThrow("duplicates FutureGovernor device 'duplicate'")

    expect(() =>
      parse(
        caseBytes({
          devices: [
            { class: 'FutureGovernor', id: 'one' },
            { class: 'Future_Governor', id: 'two' },
          ],
        }),
      ),
    ).toThrow("class 'Future_Governor' collides with 'FutureGovernor' as 'future_governor'")
  })
})
