import { createRequire } from 'node:module'

import { Data, Patch, type View } from 'latkit'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'

import type { Summary } from '../../shared/messages.js'
import { loadNative } from '../../workers/native.js'
const request = vi.hoisted(() => vi.fn())
vi.mock('../bridge.js', () => ({ bridge: { request } }))
import { DiagramEditor, positions, previewOf } from './edit.js'
const blocks = [{ table: 'Device', position: ['x', 'y'] as [string, string], ports: [] }]
const summary = {
  uri: 'file:///case',
  version: 1,
  definition: { drawing: { blocks } },
} as unknown as Summary
beforeAll(() => loadNative(createRequire(import.meta.url).resolve('latkit/wasm')))
beforeEach(() => {
  request.mockReset()
  request.mockResolvedValue(null)
})
function fixture(
  arrange = async () => [
    new Patch('case').set('Device', ['a/b', '0'], { x: [10, 20], y: [30, 40] }),
  ],
) {
  const events = new Map<string, (event: unknown) => void>()
  const source = new Data('case').replace('Device', ['a/b', '0'], { x: [NaN, NaN], y: [NaN, NaN] })
  const view = {
    on: (name: string, handler: (event: unknown) => void) => {
      events.set(name, handler)
      return () => events.delete(name)
    },
    arrange: vi.fn(arrange),
  } as unknown as View
  const replace = vi.fn()
  const error = vi.fn()
  const editor = new DiagramEditor(view, source, summary, replace, error)
  return {
    source,
    editor,
    view,
    replace,
    error,
    emit: (name: string, event: unknown) => events.get(name)?.(event),
    close: () => {
      editor.destroy()
      source.destroy()
    },
  }
}
const drag = (phase: string, position = [55, 66]) => ({
  phase,
  hit: { row: { data: 'case', table: 'Device', id: 'a/b' } },
  position,
})
it('materializes automatic positions with the moved block in one source transaction', async () => {
  const rig = fixture()
  try {
    await vi.waitFor(() => expect(rig.replace).toHaveBeenCalledOnce())
    await Promise.resolve()
    rig.emit('drag', drag('end'))
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect(request.mock.calls[0]![1]).toMatchObject({
      revision: { uri: summary.uri, version: 1 },
      mutations: [
        { kind: 'move', entity: { table: 'Device', id: 'a/b' }, position: [55, 66] },
        { kind: 'move', entity: { table: 'Device', id: '0' }, position: [20, 40] },
      ],
    })
    expect(rig.replace).toHaveBeenLastCalledWith(rig.source)
    expect(rig.source.get('Device', 'a/b', 'x')).toBeNull()
  } finally {
    rig.close()
  }
})
it('cancels arrangement and never commits a late drag after source replacement', async () => {
  let resolve!: (patches: Patch[]) => void
  const pending = new Promise<Patch[]>((done) => {
    resolve = done
  })
  const rig = fixture(() => pending)
  const signal = vi.mocked(rig.view.arrange).mock.calls[0]![0]!.signal!
  rig.editor.destroy()
  expect(signal.aborted).toBe(true)
  resolve([new Patch('case').set('Device', ['a/b'], { x: [1], y: [2] })])
  await Promise.resolve()
  await Promise.resolve()
  rig.emit('drag', drag('end'))
  expect(request).not.toHaveBeenCalled()
  rig.source.destroy()
})
it('recreates a preview after a rejected transaction so another edit can succeed', async () => {
  request.mockRejectedValueOnce(new Error('Revision changed'))
  const rig = fixture()
  try {
    await vi.waitFor(() => expect(rig.view.arrange).toHaveBeenCalledOnce())
    await Promise.resolve()
    rig.emit('drag', drag('end'))
    await vi.waitFor(() => expect(rig.error).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(rig.view.arrange).toHaveBeenCalledTimes(2))
    rig.emit('drag', drag('end', [3, 4]))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  } finally {
    rig.close()
  }
})
it('arranges all by clearing positions in a copy and leaves the source unchanged', async () => {
  const rig = fixture()
  try {
    await rig.editor.arrange()
    expect(request).toHaveBeenCalledOnce()
    expect(rig.source.get('Device', '0', 'y')).toBeNull()
    using copy = previewOf(rig.source)
    copy.set('Device', ['0'], { x: [1], y: [2] })
    expect(positions(copy, blocks)).toEqual([
      { entity: { table: 'Device', id: '0' }, position: [1, 2] },
    ])
    expect(positions(rig.source, blocks)).toEqual([])
  } finally {
    rig.close()
  }
})
it('uses structured native IDs for connection and delete transactions', async () => {
  const rig = fixture()
  try {
    await Promise.resolve()
    await Promise.resolve()
    rig.emit('connect', {
      from: { row: { table: 'Device', id: 'a/b' }, port: 'ports.out' },
      to: { row: { table: 'Device', id: '0' }, port: 'ports.in' },
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    expect(request.mock.calls[0]![1].mutations[0]).toEqual({
      kind: 'connect',
      from: { table: 'Device', id: 'a/b', field: 'ports.out' },
      to: { table: 'Device', id: '0', field: 'ports.in' },
    })
    rig.emit('delete', { rows: [{ table: 'Device', ids: ['a/b', '0'] }] })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    expect(request.mock.calls[1]![1].mutations[0]).toEqual({
      kind: 'remove',
      entities: [
        { table: 'Device', id: 'a/b' },
        { table: 'Device', id: '0' },
      ],
    })
  } finally {
    rig.close()
  }
})
