import { itemOf } from '@latkit/model'
import { expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

import { Cases } from '../src/case.js'
import { Documents } from '../src/documents.js'
import { classCapabilities, menuContext } from '../src/menus.js'
import { ElementStatus } from '../src/status.js'
import { tableColumns } from '../src/table/columns.js'
import { caseText } from './support/case.js'
import { inlineParser } from './support/parser.js'
import { activeEditorChanged, statusItems } from './support/vscode.js'

async function setup() {
  const documents = new Documents(inlineParser)
  const cases = new Cases(documents)
  const make = (path: string) =>
    cases.get({
      uri: { path, toString: () => `file://${path}` },
      version: 1,
      isClosed: false,
      languageId: 'json',
      getText: () =>
        caseText({
          buses: [{ number: 2, x: 8, init: { x: 4 }, params: { x: 9 } }, { number: 10 }],
          devices: [{ class: 'LoadZ', id: 'load-1', ports: { bus: 2 }, params: { p: 5 } }],
        }),
      positionAt: (character: number) => ({ line: 0, character }),
    } as unknown as vscode.TextDocument)
  const a = make('/a.case.json')
  const b = make('/b.case.json')
  await Promise.all([documents.ensureParsed(a.document), documents.ensureParsed(b.document)])
  return {
    cases,
    a,
    b,
    dispose: () => {
      cases.dispose()
      documents.dispose()
    },
  }
}
it('uses the same element and field selection for all observers and preserves anchored device identity', async () => {
  const t = await setup()
  const first = vi.fn()
  const second = vi.fn()
  t.a.onDidChange(first)
  t.a.onDidChange(second)
  t.cases.focus(t.b)
  await t.cases.select(t.a.target, { element: { classId: 'load_z', index: 0 } })
  expect(t.cases.focused).toBe(t.b)
  expect(t.cases.active).toBe(t.b)
  expect(t.a.selection?.element.classId).toBe('load_z')
  expect(itemOf(t.a.fields!.model, t.a.selection!.element)).toEqual({ kind: 'vertex', index: 0 })
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(1)
  await t.cases.select(t.a.target, { element: { classId: 'load_z', index: 0 } })
  expect(first).toHaveBeenCalledTimes(1)
  await t.cases.select(t.a.target, {
    element: { classId: 'bus', index: 0 },
    field: { classId: 'bus', source: 'column', id: 'params.x' },
  })
  expect(t.a.selection?.field?.id).toBe('params.x')
  await t.cases.select(t.a.target, {
    element: { classId: 'bus', index: 0 },
    field: { classId: 'load_z', source: 'column', id: 'params.p' },
  })
  expect(t.a.selection?.field?.id).toBe('params.x')
  t.dispose()
})
it('rejects superseded field selection reads and missing fields', async () => {
  const t = await setup()
  const data = await t.a.fields!.model.load('bus')
  let finish!: (column: (typeof data.columns)[number]) => void
  vi.spyOn(t.a.fields!, 'field').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = t.cases.select(t.a.target, {
    element: { classId: 'bus', index: 0 },
    field: { classId: 'bus', source: 'column', id: 'params.x' },
  })
  await t.cases.select(t.a.target, { element: { classId: 'bus', index: 1 } })
  finish(data.columns[0])
  await pending
  expect(t.a.selection).toEqual({ element: { classId: 'bus', index: 1 } })
  await t.cases.select(t.a.target, {
    element: { classId: 'bus', index: 0 },
    field: { classId: 'bus', source: 'column', id: 'missing' },
  })
  expect(t.a.selection?.element.index).toBe(1)
  t.dispose()
})
it('keeps element capabilities equal across views while adding cell context', async () => {
  const t = await setup()
  const target = { ...t.a.target, element: { classId: 'bus', index: 0 } }
  const caps = classCapabilities(t.a.fields!.model, 'bus', true, t.a.bindings)
  const { gridkitOrigin: _a, ...network } = menuContext(target, caps, 'network')
  const { gridkitOrigin: _b, ...table } = menuContext(target, caps, 'table')
  expect(network).toEqual(table)
  expect(table.gridkitBindable).toBe(true)
  const field = { classId: 'bus', source: 'column', id: 'params.x' } as const
  await t.a.bind(t.a.target, 'vertexColor', { field })
  const cell = menuContext(
    { ...target, field },
    classCapabilities(t.a.fields!.model, 'bus', true, t.a.bindings),
    'table',
  )
  expect(cell).toMatchObject({
    gridkitElement: true,
    gridkitField: true,
    gridkitNetwork: true,
    gridkitBindable: true,
    gridkitBound: true,
  })
  expect(classCapabilities(t.a.fields!.model, 'load_z', true, t.a.bindings)).toMatchObject({
    network: true,
    bind: false,
  })
  t.dispose()
})
it('presents one real identifier and qualifies only colliding labels without losing column indexes', async () => {
  const t = await setup()
  const data = await t.a.fields!.model.load('bus')
  const columns = tableColumns(data, 'bus')
  expect(columns[0]).toMatchObject({ id: 'top.number', label: 'number', identity: true })
  expect(columns.filter((column) => column.identity)).toHaveLength(1)
  expect(
    columns.filter((column) => column.id?.endsWith('.x')).map((column) => column.label),
  ).toEqual(['x (top)', 'x (initial)', 'x (parameter)'])
  expect(columns.every((column) => column.id === data.columns[column.index].id)).toBe(true)
  expect(tableColumns({ labels: ['#0'], columns: [] }, 'branch')[0]).toMatchObject({
    id: null,
    identity: true,
  })
  t.dispose()
})
it('shows contextual selection status with a frozen source target and hides for unrelated editors', async () => {
  const t = await setup()
  const status = new ElementStatus(t.cases)
  const item = statusItems.filter((item) => item.name === 'Focused Case Element').at(-1)!
  t.cases.focus(t.a)
  await t.cases.select(t.a.target, {
    element: { classId: 'bus', index: 0 },
    field: { classId: 'bus', source: 'column', id: 'params.x' },
  })
  await vi.waitFor(() => expect(item.text).toContain('Bus 2'))
  expect(item.text).toContain('x')
  expect(item.command?.arguments?.[0]).toMatchObject({
    ...t.a.target,
    element: { classId: 'bus', index: 0 },
  })
  const hidden = item.hide.mock.calls.length
  activeEditorChanged.fire({ document: { uri: { path: '/notes.txt' } } } as vscode.TextEditor)
  expect(item.hide.mock.calls.length).toBeGreaterThan(hidden)
  t.cases.focus(t.a)
  await vi.waitFor(() => expect(item.show).toHaveBeenCalledTimes(2))
  await t.cases.select(t.a.target, null)
  expect(item.hide.mock.calls.length).toBeGreaterThan(hidden + 1)
  status.dispose()
  t.dispose()
})

it('selection never moves case focus, even when its field read settles late', async () => {
  const t = await setup()
  const data = await t.a.fields!.model.load('bus')
  let finish!: (column: (typeof data.columns)[number]) => void
  vi.spyOn(t.a.fields!, 'field').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = t.cases.select(t.a.target, {
    element: { classId: 'bus', index: 0 },
    field: { classId: 'bus', source: 'column', id: 'params.x' },
  })
  t.cases.focus(t.b)
  finish(data.columns[0])
  await pending
  expect(t.cases.active).toBe(t.b)
  expect(t.cases.focused).toBe(t.b)
  t.dispose()
})
