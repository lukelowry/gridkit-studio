/** Exercise the installed patch, including the native reader; no copied picker implementation. */
import { appendData, createData, createReader, type ReadScope, textColumn } from '@latkit/model'
import { expect, it } from 'vitest'

const { pick } = (await import(
  new URL('../../../node_modules/@latkit/monitor/dist/picking.js', import.meta.url).href
)) as {
  pick(request: {
    reads: ReadScope
    [key: string]: unknown
  }): Promise<{ row: number; frame: number; value: number }[]>
}

async function hits(
  coordinates: number[],
  values: number[],
  point: number[],
  interpolation = 'linear',
  count = 1,
  widthPx?: number,
) {
  const index = { source: 'case', type: 'Bus', version: '1' }
  const rows = { kind: 'range' as const, offset: 0, count }
  const base = createData(
    {
      axis: { name: 'time' },
      types: { Bus: { fields: { Vm: { type: 'float64', sampled: true } } } },
    },
    [
      {
        kind: 'rows',
        index,
        rows,
        ids: textColumn(Array.from({ length: count }, (_, i) => `Bus/${i}`)),
        columns: {},
      },
    ],
  )
  const source = appendData(base, [
    {
      kind: 'samples',
      index,
      rows,
      firstFrame: 0,
      coordinates: Float64Array.from(coordinates),
      columns: {
        Vm: {
          kind: 'numeric',
          values: Float64Array.from(values),
          offset: 0,
          length: values.length,
          rowStride: 1,
          frameStride: count,
        },
      },
    },
  ])
  const reader = createReader()
  const reads = reader.open()
  try {
    return await pick({
      reads,
      data: { source },
      bindings: [
        {
          source,
          field: 'Vm',
          name: 'voltage',
          trace: { from: 'Bus', interpolation },
          rows: { ...rows, index },
          fields: { value: 'Vm' },
          bound: { channels: { widthPx: widthPx === undefined ? {} : { constant: widthPx } } },
          channels: {
            y: { column: 'value', component: 0, fallback: NaN },
            visible: { component: 0, fallback: 1 },
            widthPx: { component: 0, fallback: NaN },
          },
        },
      ],
      plot: { x: 0, y: 0, width: 100, height: 100 },
      x: [0, 10],
      y: [0, 2],
      width: 1.25,
      point,
      radius: 2,
      limit: 16,
    })
  } finally {
    reads.close()
    reader.destroy()
  }
}

it('selects the middle of a visible segment even when both samples are outside the pointer window', async () => {
  expect(await hits([0, 10], [1, 1], [50, 50])).toHaveLength(1)
})
it('selects a single recorded observation drawn as a point', async () => {
  expect(await hits([5], [1], [50, 50])).toHaveLength(1)
})
it('returns distinct traces instead of filling the hit list with neighboring samples', async () => {
  const result = await hits([4.8, 4.9, 5, 5.1, 5.2], Array(10).fill(1), [50, 50], 'linear', 2)
  expect(result.map((hit) => hit.row).sort()).toEqual([0, 1])
})
it('matches both step interpolations rather than selecting their invisible diagonal', async () => {
  expect(await hits([0, 10], [0, 2], [50, 0], 'step-before')).toHaveLength(1)
  expect(await hits([0, 10], [0, 2], [50, 100], 'step-after')).toHaveLength(1)
  expect(await hits([0, 10], [0, 2], [50, 50], 'step-before')).toHaveLength(0)
  expect(await hits([0, 10], [0, 2], [0, 50], 'step-before')).toHaveLength(1)
})
it('does not invent segments across nonfinite samples', async () => {
  expect(await hits([0, 5, 10], [1, NaN, 1], [50, 50])).toHaveLength(0)
})
it('picks the valid held leg of a step-after trace before a missing observation', async () => {
  const result = await hits([0, 5, 10], [1, NaN, 1], [25, 50], 'step-after')
  expect(result).toHaveLength(1)
  expect(result[0]!.value).toBe(1)
  expect(await hits([0, 5, 10], [1, NaN, 1], [75, 50], 'step-after')).toHaveLength(0)
})
it('hits a wide line across its stroke, not only near its center', async () => {
  // 8 px off a flat line: past a thin stroke and the pointer's 2 px, within a 20 px stroke.
  expect(await hits([0, 10], [1, 1], [50, 58])).toHaveLength(0)
  expect(await hits([0, 10], [1, 1], [50, 58], 'linear', 1, 20)).toHaveLength(1)
})
it('does not pick a trace entirely clipped outside the value axis', async () => {
  expect(await hits([0, 10], [2.04, 2.04], [50, 0])).toHaveLength(0)
})
