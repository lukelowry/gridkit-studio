import { applyEdits } from 'jsonc-parser'
import { expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

import { channelsFor, DISPLAY_CHANNELS, renderValues } from '../src/bindings.js'
import { type Cases, CaseState, type DocumentEdits } from '../src/case.js'
import { CaseFields, signalStatus } from '../src/fields.js'
import { parse } from '../src/gridkit/parse.js'
import { caseGrid } from '../src/table/grid.js'
import { targetOf } from '../src/targets.js'
import { caseBytes } from './support/case.js'

const field = { classId: 'bus', source: 'column', id: 'params.x' } as const
function fixture(uri = 'file:///case.case.json') {
  const parsed = parse(
    caseBytes({
      buses: [
        { number: 2, x: 8, init: { x: 7 }, params: { x: 1.000000000000001 } },
        { number: 10, x: 9, init: { x: 6 }, params: { x: 1.000000000000002 } },
      ],
      devices: [
        { class: 'Branch', ports: { bus1: 2, bus2: 10 }, params: { x: 4 } },
        { class: 'LoadZ', ports: { bus: 2 }, params: { x: 3 } },
        { class: 'LoadZ', ports: { bus: 2 }, params: { x: 8 } },
      ],
    }),
  )
  const { model } = parsed
  const document = {
    uri: { toString: () => uri },
    version: 1,
    isClosed: false,
  } as unknown as vscode.TextDocument
  const state = new CaseState(document, { state: 'valid', version: 1, case: parsed })
  return { model, parsed, document, state }
}
it('keeps colliding field identities, readable labels, and exact numeric values', async () => {
  const { model, state } = fixture()
  const data = await model.load('bus')
  expect(data.columns.filter((c) => c.label === 'x').map((c) => c.id)).toEqual([
    'top.x',
    'init.x',
    'params.x',
  ])
  const fields = new CaseFields(model)
  expect((await fields.column(field)).values[0]).toBe(1.000000000000001)
  const values = await fields.values('vertexColor', { field })
  expect([...values]).toEqual([0, 1])
  expect(await fields.values('vertexColor', { field })).toBe(values)
  state.dispose()
})
it('allows all display channels only on direct owners, without aggregating devices', () => {
  const { model, state } = fixture()
  expect(DISPLAY_CHANNELS).toEqual([
    'vertexColor',
    'vertexHeight',
    'vertexSize',
    'edgeColor',
    'edgeDash',
  ])
  expect(channelsFor(model, field)).toEqual(['vertexColor', 'vertexHeight', 'vertexSize'])
  expect(channelsFor(model, { ...field, classId: 'branch' })).toEqual(['edgeColor', 'edgeDash'])
  expect(channelsFor(model, { ...field, classId: 'load_z' })).toEqual([])
  expect(channelsFor(model, { ...field, source: 'signal' })).toEqual([
    'vertexColor',
    'vertexHeight',
    'vertexSize',
  ])
  state.dispose()
})
it('defines missing, constant, extreme, and raw dash behavior centrally', () => {
  expect([...renderValues(new Float64Array([NaN, 5, 5]), 'vertexHeight')]).toEqual([0, 0.5, 0.5])
  expect([...renderValues(new Float64Array([NaN, NaN]), 'vertexColor')]).toEqual([NaN, NaN])
  expect([...renderValues(new Float64Array([-1e308, 0, 1e308]), 'vertexSize')]).toEqual([0, 0.5, 1])
  expect([...renderValues(new Float64Array([-1, 0, 2, NaN]), 'edgeDash')]).toEqual([0, 0, 2, 0])
})
it('retains source indexes and precision through sorting, filtering and windows', async () => {
  const { model, state } = fixture()
  const data = await model.load('bus')
  const grid = caseGrid(data)
  const sort = { column: 'params.x', dir: 'desc' } as const
  const window = await grid.window('', sort, 0, 1)
  expect(window.rows[0].index).toBe(1)
  expect(window.rows[0].cells.at(-1)).toBe('1.000000000000002')
  expect(await grid.locate(0, '', sort)).toBe(1)
  expect((await grid.window('10', sort, 0, 2)).rows.map((r) => r.index)).toEqual([1])
  const abort = new AbortController()
  abort.abort()
  await expect(grid.window('', null, 0, 2, abort.signal)).rejects.toMatchObject({
    name: 'AbortError',
  })
  grid.dispose()
  state.dispose()
})
it('shares selection and binding events, validates ranges and unbinds', async () => {
  const { state } = fixture()
  const a = vi.fn()
  const b = vi.fn()
  state.onDidChange(a)
  state.onDidChange(b)
  const target = state.target
  await state.select(target, { element: { classId: 'bus', index: 1 } })
  expect(state.selection?.element.index).toBe(1)
  expect(a).toHaveBeenCalledWith('selection')
  expect(b).toHaveBeenCalledWith('selection')
  await state.bind(target, 'vertexColor', { field })
  await expect(state.bind(target, 'edgeColor', { field })).rejects.toThrow('direct bus or branch')
  await expect(state.bind(target, 'vertexColor', { field, range: [1, 1] })).rejects.toThrow(
    'increasing',
  )
  await state.bind(target, 'vertexColor', null)
  expect(state.bindings).toEqual({})
  state.dispose()
})
it('rejects stale and cross-case selections and cancels superseded binding reads', async () => {
  const { state, model, parsed, document } = fixture()
  const target = state.target
  let finish!: (data: Awaited<ReturnType<typeof model.load>>) => void
  state.fields = new CaseFields({
    ...model,
    load: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  })
  const pending = state.bind(target, 'vertexColor', { field })
  await state.bind(target, 'vertexColor', null)
  finish(await model.load('bus'))
  await pending
  expect(state.bindings).toEqual({})
  Object.assign(document, { version: 2 })
  state.update({ state: 'pending', version: 2 })
  await state.select(target, { element: { classId: 'bus', index: 0 } })
  await state.bind(target, 'vertexColor', { field })
  expect(state.selection).toBeNull()
  expect(state.bindings).toEqual({})
  state.update({ state: 'valid', version: 2, case: parsed })
  await state.select(
    { ...state.target, uri: 'file:///elsewhere' },
    { element: { classId: 'bus', index: 0 } },
  )
  expect(state.selection).toBeNull()
  state.dispose()
})
it('invalidates closed/reopened cases even when the document version repeats', () => {
  const first = fixture()
  const next = fixture()
  expect(next.state.current(first.state.target)).toBe(false)
  first.state.dispose()
  next.state.dispose()
})
it('drops removed bindings after edits and retains surviving fields', async () => {
  const { state, parsed, document } = fixture()
  await state.bind(state.target, 'vertexColor', { field })
  Object.assign(document, { version: 2 })
  state.update({ state: 'valid', version: 2, case: parsed })
  await vi.waitFor(() => expect(state.bindings.vertexColor).toBeDefined())
  Object.assign(document, { version: 3 })
  state.update({ state: 'valid', version: 3, case: parse(caseBytes({ buses: [{ number: 1 }] })) })
  await vi.waitFor(() => expect(state.bindings.vertexColor).toBeUndefined())
  state.dispose()
})
it('takes native menu identity from its supplied frozen target', () => {
  const { state } = fixture()
  const target = { ...state.target, element: { classId: 'bus', index: 0 } }
  expect(targetOf({ gridkitTarget: target })).toBe(target)
  expect(targetOf({ target })).toBe(target)
  expect(targetOf({ gridkitTarget: { ...target, version: -1 } })).toBeUndefined()
  expect(targetOf({})).toBeUndefined()
  state.dispose()
})

it('keeps samples, plot preferences, and pending bindings when only monitored signals change', async () => {
  const { state, model, document } = fixture()
  const signal = { classId: 'bus', source: 'signal', id: 'Vm' } as const
  await state.select(state.target, { element: { classId: 'bus', index: 1 } })
  const selection = state.selection
  await state.bind(state.target, 'vertexColor', { field: signal })
  state.setDisplay({ plots: new Map([['Vm', { field: signal, valueRange: [0.9, 1.1] }]]) })
  const source = {
    dispose: vi.fn(),
    has: () => true,
  } as unknown as import('../src/csv/source.js').CsvSource
  state.source = source
  const raw = JSON.parse(new TextDecoder().decode(await model.bytes!()))
  raw.buses[0].mon = ['Vm']
  Object.assign(document, { version: 2 })
  state.update({ state: 'pending', version: 2 })
  state.update({
    state: 'valid',
    version: 2,
    case: parse(new TextEncoder().encode(JSON.stringify(raw))),
  })
  await vi.waitFor(() => expect(state.bindings.vertexColor?.field).toEqual(signal))
  expect(state.source).toBe(source)
  expect(state.selection).toBe(selection)
  expect(state.plots.get('Vm')?.valueRange).toEqual([0.9, 1.1])
  expect(source.dispose).not.toHaveBeenCalled()
  state.dispose()
})

it('queues monitoring gestures, rebases only compatible edits, and recovers after a rejected write', async () => {
  const { state, parsed, document } = fixture()
  let text = JSON.stringify(parsed.raw)
  Object.assign(document, { getText: () => text })
  const edit = vi.fn(async (changes: readonly DocumentEdits[]) => {
    await Promise.resolve()
    text = applyEdits(text, [...changes[0].edits])
    Object.assign(document, { version: document.version + 1 })
    state.update({
      state: 'valid',
      version: document.version,
      case: parse(new TextEncoder().encode(text)),
    })
  })
  const cases = { edit } as unknown as Cases
  const key = state.inputKey!
  const field = { classId: 'bus', source: 'signal' as const, id: 'Vm' }
  await Promise.all([
    state.updateMonitoring(cases, key, [{ field, elements: [0, 1], enabled: true }]),
    state.updateMonitoring(cases, key, [
      { field: { ...field, id: 'Va' }, elements: [1], enabled: true },
    ]),
    state.updateMonitoring(cases, key, [{ field, elements: [0], enabled: false }]),
  ])
  expect(state.signalState(field)).toMatchObject({ monitored: 1, available: 0, total: 2 })
  expect(JSON.parse(text).buses[1].mon).toEqual(['Vm', 'Va'])
  edit.mockRejectedValueOnce(new Error('The edit could not be applied.'))
  await expect(
    state.updateMonitoring(cases, key, [{ field, elements: [0], enabled: true }]),
  ).rejects.toThrow('could not')
  await state.updateMonitoring(cases, key, [{ field, elements: [0], enabled: true }])
  expect(state.signalState(field).monitored).toBe(2)
  const changed = JSON.parse(text)
  changed.buses[0].params.x = 7
  Object.assign(document, { version: document.version + 1 })
  state.update({
    state: 'valid',
    version: document.version,
    case: parse(new TextEncoder().encode(JSON.stringify(changed))),
  })
  await expect(
    state.updateMonitoring(cases, key, [{ field, elements: [0], enabled: false }]),
  ).rejects.toThrow('case changed')
  state.dispose()
})
it('distinguishes headers, partial samples, next-run monitoring, and missing output', () => {
  const { state } = fixture()
  const field = { classId: 'bus', source: 'signal' as const, id: 'Vm' }
  const source = {
    info: { rows: 0 },
    recordedCount: (_field: unknown, element?: number) =>
      element === undefined || element === 0 ? 1 : 0,
    dispose: vi.fn(),
  }
  state.source = source as unknown as import('../src/csv/source.js').CsvSource
  expect(state.signalState(field).available).toBe(0)
  source.info.rows = 3
  expect(signalStatus(state.signalState(field))).toBe('Samples for 1 of 2 elements.')
  expect(state.signalState(field, 1).available).toBe(0)
  expect(
    signalStatus({ total: 2, monitored: 2, available: 0, expected: 0, runStatus: 'running' }),
  ).toBe('Enabled for the next run.')
  expect(
    signalStatus({ total: 2, monitored: 0, available: 0, expected: 1, runStatus: 'completed' }),
  ).toBe('GridKit did not output this signal.')
  state.dispose()
})
it('sends a full snapshot when valid input returns after a parse error', () => {
  const { state, parsed, document } = fixture()
  const changes = vi.fn()
  state.onDidChange(changes)
  Object.assign(document, { version: 2 })
  state.update({ state: 'invalid', version: 2, issues: [] })
  Object.assign(document, { version: 3 })
  state.update({ state: 'pending', version: 3 })
  state.update({ state: 'valid', version: 3, case: parsed })
  expect(changes).toHaveBeenLastCalledWith('snapshot')
  state.dispose()
})

it('retains unfamiliar CSV-backed signal bindings after removing their last monitored entry', async () => {
  const { state, parsed, document } = fixture()
  const signal = { classId: 'bus', source: 'signal', id: 'custom' } as const
  const monitored = {
    ...parsed.raw,
    buses: parsed.raw.buses.map((bus, i) => (i ? bus : { ...bus, mon: ['custom'] })),
  }
  state.update({
    state: 'valid',
    version: 1,
    case: parse(new TextEncoder().encode(JSON.stringify(monitored))),
  })
  state.setDisplay({ plots: new Map([['custom', { field: signal }]]) })
  state.source = {
    fields: [signal],
    dispose: vi.fn(),
  } as unknown as import('../src/csv/source.js').CsvSource
  await state.bind(state.target, 'vertexColor', { field: signal })
  await expect(
    state.bind(state.target, 'vertexColor', { field: { ...signal, id: 'missing' } }),
  ).rejects.toThrow('field no longer exists')
  const raw = { ...parsed.raw, buses: parsed.raw.buses.map((bus) => ({ ...bus, mon: [] })) }
  Object.assign(document, { version: 2 })
  state.update({
    state: 'valid',
    version: 2,
    case: parse(new TextEncoder().encode(JSON.stringify(raw))),
  })
  await Promise.resolve()
  expect(state.fields!.signals('bus').some((field) => field.id === 'custom')).toBe(true)
  expect(state.bindings.vertexColor?.field).toEqual(signal)
  expect(state.plots.get('custom')?.field).toEqual(signal)
  expect(state.signalState(signal).monitored).toBe(0)
  state.dispose()
})
