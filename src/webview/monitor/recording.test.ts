import { appendData, createData, createReader, textColumn } from '@latkit/model'
import { expect, it } from 'vitest'

import { traceSelection } from './plot.js'

it('reads a recorded subset through the renderer field reader', async () => {
  const index = { source: 'recording', type: 'Bus', version: 'one' }
  const source = createData(
    {
      axis: { name: 'time', unit: 's' },
      types: { Bus: { fields: { Vm: { type: 'float64', sampled: true } } } },
    },
    [
      {
        kind: 'rows',
        index,
        rows: { kind: 'range', offset: 0, count: 2 },
        ids: textColumn(['Bus/1', 'Bus/2']),
        columns: {},
      },
    ],
  )
  const data = appendData(source, [
    {
      kind: 'samples',
      index,
      rows: { kind: 'range', offset: 0, count: 1 },
      firstFrame: 0,
      coordinates: Float64Array.of(0, 1, 2),
      columns: {
        Vm: {
          kind: 'numeric',
          values: Float64Array.of(1, 0.8, 1),
          offset: 0,
          rowStride: 1,
          frameStride: 1,
          length: 3,
        },
      },
    },
  ])
  expect(traceSelection(data, 'Bus/2', 'Bus', { kind: 'ids', ids: ['Bus/1'] })).toEqual([])
  expect(traceSelection(data, 'Bus/1', 'Bus', { kind: 'ids', ids: ['Bus/1'] })).toHaveLength(1)
  expect(traceSelection(data, 'Bus/99999', 'Bus')).toEqual([])
  const reader = createReader()
  const scope = reader.open()
  const blocks = []
  try {
    for await (const block of scope.fields({
      source: data,
      from: 'Bus',
      rows: { kind: 'ids', ids: ['Bus/1'] },
      fields: { y: 'Vm' },
      window: { kind: 'frames', offset: 0, count: 3 },
    }))
      blocks.push(block)
    expect(blocks.length).toBeGreaterThan(0)
  } finally {
    scope.close()
    reader.destroy()
  }
})
