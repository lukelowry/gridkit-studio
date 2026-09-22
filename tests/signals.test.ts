import { applyEdits } from 'jsonc-parser'
import { expect, it } from 'vitest'
import type * as vscode from 'vscode'

import { Cases } from '../src/case.js'
import { Documents } from '../src/documents.js'
import { parse } from '../src/gridkit/parse.js'
import { validate } from '../src/gridkit/validate.js'
import { monitored, monitoringEdits } from '../src/signals/edits.js'
import { SignalsTree } from '../src/signals/tree.js'
import { caseText } from './support/case.js'
import { inlineParser } from './support/parser.js'

it('edits only targeted monitor entries and preserves parameters, other classes, and formatting', () => {
  const text = caseText({
    buses: [
      { number: 1, mon: ['Vr'] },
      { number: 2, mon: ['Vm'] },
    ],
    devices: [{ class: 'Genrou', id: 'a', ports: { bus: 1 }, mon: ['speed'] }],
  })
  const edits = monitoringEdits(text, [
    { field: { classId: 'bus', source: 'signal', id: 'Vm' }, elements: [0], enabled: true },
  ])
  const next = applyEdits(text, edits)
  const raw = validate(JSON.parse(next))
  expect(raw.buses[0].mon).toEqual(['Vr', 'Vm'])
  expect(raw.buses[1].mon).toEqual(['Vm'])
  expect(raw.devices[0].mon).toEqual(['speed'])
  expect(monitored(raw, { classId: 'bus', source: 'signal', id: 'Vm' })).toEqual([0, 1])
  expect(
    monitoringEdits(next, [
      { field: { classId: 'bus', source: 'signal', id: 'Vm' }, elements: [0], enabled: true },
    ]),
  ).toEqual([])
  expect(parse(new TextEncoder().encode(next)).inputIdentity).toBe(
    parse(new TextEncoder().encode(text)).inputIdentity,
  )
})
it('addresses interleaved device classes by original element index', () => {
  const text = caseText({
    buses: [{ number: 1 }],
    devices: [
      { class: 'Genrou', id: 'a', ports: { bus: 1 } },
      { class: 'LoadZ', id: 'l', ports: { bus: 1 } },
      { class: 'Genrou', id: 'b', ports: { bus: 1 } },
    ],
  })
  const next = JSON.parse(
    applyEdits(
      text,
      monitoringEdits(text, [
        {
          field: { classId: 'genrou', source: 'signal', id: 'speed' },
          elements: [1],
          enabled: true,
        },
      ]),
    ),
  )
  expect(next.devices[0].mon).toBeUndefined()
  expect(next.devices[1].mon).toBeUndefined()
  expect(next.devices[2].mon).toEqual(['speed'])
})

it('merges multiple checkbox changes into one element edit without losing other signals', () => {
  const text = caseText({ buses: [{ number: 1, mon: ['Vm', 'Vr'] }, { number: 2 }] })
  const field = { classId: 'bus', source: 'signal' as const, id: 'Vm' }
  const edits = monitoringEdits(text, [
    { field, elements: [0, 1], enabled: false },
    { field: { ...field, id: 'Va' }, elements: [0, 1], enabled: true },
    { field, elements: [1], enabled: true },
  ])
  expect(
    JSON.parse(applyEdits(text, edits)).buses.map((bus: { mon: string[] }) => bus.mon),
  ).toEqual([
    ['Vr', 'Va'],
    ['Va', 'Vm'],
  ])
  expect(monitoringEdits(text, [{ field, elements: [0], enabled: true }])).toEqual([])
})

it('keeps CSV-backed signals discoverable when a class has no configured monitors', async () => {
  const documents = new Documents(inlineParser)
  const cases = new Cases(documents)
  const path = '/signals.case.json'
  const state = cases.get({
    uri: { path, toString: () => 'file://' + path },
    version: 1,
    isClosed: false,
    languageId: 'json',
    getText: () =>
      caseText({ buses: [{ number: 1 }], devices: [{ class: 'Unknown', ports: { bus: 1 } }] }),
    positionAt: (character: number) => ({ line: 0, character }),
  } as unknown as vscode.TextDocument)
  await documents.ensureParsed(state.document)
  const field = { classId: 'unknown', source: 'signal', id: 'custom' } as const
  state.source = {
    fields: [field],
    dispose: () => {},
  } as unknown as import('../src/csv/source.js').CsvSource
  cases.activate(state)
  const tree = new SignalsTree(cases, { subscriptions: [] } as unknown as vscode.ExtensionContext)
  const parent = tree.getChildren().find((item) => item.classId === field.classId)
  expect(parent).toBeDefined()
  expect(tree.getChildren(parent).some((item) => item.target.field?.id === field.id)).toBe(true)
  tree.dispose()
  cases.dispose()
  documents.dispose()
})
