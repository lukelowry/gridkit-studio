import { expect, it } from 'vitest'

import { packed } from './packed.js'

it('sends a message of more buffers than VS Code counts as one buffer of views', () => {
  const few = { arrays: [Float64Array.of(1), Uint32Array.of(2)] }
  expect(packed(few)).toBe(few)
  const coordinates = Float64Array.of(0.5)
  const message = {
    kind: 'batch',
    batches: Array.from({ length: 300 }, (_, i) => ({
      coordinates,
      values: Float64Array.of(i, i + 0.5),
      rows: Uint32Array.of(i),
      at: i,
    })),
  }
  const sent = packed(message)
  const views = sent.batches.flatMap(({ coordinates, values, rows }) => [coordinates, values, rows])
  expect(new Set(views.map((view) => view.buffer)).size).toBe(1)
  // Each array is a view of its own type, holding what it held; one array stays one view.
  expect(sent.batches.map(({ values }) => Array.from(values))).toEqual(
    message.batches.map(({ values }) => Array.from(values)),
  )
  expect(sent.batches[299]!.rows).toBeInstanceOf(Uint32Array)
  expect(Array.from(sent.batches[299]!.rows)).toEqual([299])
  expect(sent.batches[0]!.coordinates).toBe(sent.batches[299]!.coordinates)
  expect(sent.batches[7]!.at).toBe(7)
})
