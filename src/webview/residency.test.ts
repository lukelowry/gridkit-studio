import { appendData, createData, textColumn } from '@latkit/model'
import { expect, it, vi } from 'vitest'

import type { ViewState } from '../shared/messages.js'
import { CommittedWindows, TimeResidency } from './residency.js'
import type { Snapshot } from './stream.js'

it('asks for a moment alone at rest, and for the times ahead while playing', () => {
  const send = vi.fn()
  const windows = new TimeResidency(send)
  windows.update(20, { from: 5, to: 10 }, false, 0)
  expect(send).toHaveBeenLastCalledWith([20, 20])
  // A late answer to another request does not stand for this one.
  windows.committed({ from: -1, to: 4 })
  windows.update(20, { from: -1, to: 4 }, false, 0)
  expect(send).toHaveBeenCalledTimes(1)
  windows.committed({ from: 20, to: 20 })
  windows.update(20, { from: 20, to: 20 }, true, 0)
  expect(send).toHaveBeenCalledTimes(1)
  // Playing from there asks ahead at once, and the ticks after wait for that answer.
  windows.update(20, { from: 20, to: 20 }, true, 1)
  expect(send).toHaveBeenLastCalledWith([19, 24])
  windows.update(20.01, { from: 20, to: 20 }, false, 1)
  expect(send).toHaveBeenCalledTimes(2)
  windows.committed({ from: 19, to: 24 })
  windows.update(22.9, { from: 19, to: 24 }, true, 1)
  expect(send).toHaveBeenCalledTimes(2)
  windows.update(23.5, { from: 19, to: 24 }, true, 1)
  expect(send).toHaveBeenLastCalledWith([22.5, 27.5])
})

it('asks sooner and farther ahead the faster it plays, in the way it plays', () => {
  const send = vi.fn()
  const windows = new TimeResidency(send)
  windows.update(26, { from: 22.5, to: 27.5 }, true, 2)
  expect(send).toHaveBeenLastCalledWith([25, 34])
  windows.committed({ from: 25, to: 34 })
  windows.update(25.5, { from: 25, to: 34 }, true, -1)
  expect(send).toHaveBeenLastCalledWith([21.5, 26.5])
})

it('reuses committed windows, evicts by memory budget, and rejects other runs or revisions', () => {
  const schema = {
    axis: { name: 'time' },
    types: { Bus: { fields: { Vm: { type: 'float64' as const, sampled: true as const } } } },
  }
  const index = { source: 'case', type: 'Bus', version: '1' }
  const axis = { kind: 'range' as const, offset: 0, count: 2 }
  const rows = createData(schema, [
    { kind: 'rows', index, rows: axis, ids: textColumn(['Bus/1', 'Bus/2']), columns: {} },
  ])
  const revision = { uri: 'case', version: 1 }
  const fields = [{ from: 'Bus', select: ['Vm'] }]
  const state: ViewState = {
    summary: {
      ...revision,
      schema,
      fingerprint: 'case',
      counts: { Bus: 2 },
      name: 'Case',
      editable: {},
      identities: {},
      parameters: {},
      issues: [],
      validation: 'complete',
      parseMs: 0,
    },
    run: {
      id: 'run',
      revision,
      fingerprint: 'case',
      name: 'Run',
      state: 'complete',
      path: 'results.arrow',
      format: 'arrow',
      started: 0,
      frames: 10,
      domain: [0, 10],
      outputs: fields,
    },
    bindings: { vertexColor: { type: 'Bus', field: 'Vm' } },
  }
  const snapshot = (at: number): Snapshot => ({
    rows,
    begin: {
      kind: 'begin',
      stream: at + 1,
      schema,
      revision,
      counts: { Bus: 2 },
      simulationId: 'run',
      fields,
      sampled: fields,
      base: true,
      append: false,
      held: { from: at, to: at + 1 },
    },
    data: appendData(rows, [
      {
        kind: 'samples',
        index,
        rows: axis,
        firstFrame: at,
        coordinates: Float64Array.of(at, at + 1),
        columns: {
          Vm: {
            kind: 'numeric',
            values: Float64Array.of(1, 1, 1, 1),
            offset: 0,
            length: 4,
            rowStride: 1,
            frameStride: 2,
          },
        },
      },
    ]),
  })
  const cache = new CommittedWindows(96)
  const first = snapshot(0)
  const second = snapshot(2)
  const third = snapshot(4)
  cache.add(first)
  cache.add(second)
  expect(cache.at(state, 0.5)).toBe(first)
  cache.add(third)
  expect(cache.at(state, 2.5)).toBeUndefined()
  expect(cache.at(state, 0.5)).toBe(first)
  expect(cache.at({ ...state, summary: { ...state.summary!, version: 2 } }, 0.5)).toBeUndefined()
  cache.add({ ...third, begin: { ...third.begin, simulationId: 'another' } })
  expect(cache.at(state, 0.5)).toBeUndefined()
})
