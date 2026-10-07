import { appendData, createData, createReader, type SampleBatch, textColumn } from '@latkit/model'
import { describe, expect, it } from 'vitest'

import {
  coversInterval,
  coversRows,
  coversTime,
  pageWindow,
  recordedSelection,
  validateCoverage,
  validateStatics,
} from './coverage.js'

const index = { source: 'case', type: 'Bus', version: '1' }
const rows = { kind: 'range' as const, offset: 0, count: 2 }
const base = () =>
  createData(
    {
      axis: { name: 'time' },
      types: {
        Bus: { fields: { x: { type: 'float64' }, Vm: { type: 'float64', sampled: true } } },
      },
    },
    [
      {
        kind: 'rows',
        index,
        rows,
        ids: textColumn(['Bus/1', 'Bus/2']),
        columns: { x: { kind: 'numeric', values: Float64Array.of(0, 1), offset: 0, length: 2 } },
      },
    ],
  )
function batch(firstFrame: number, coordinates: number[], offset = 0, count = 2): SampleBatch {
  return {
    kind: 'samples',
    index,
    rows: { kind: 'range', offset, count },
    firstFrame,
    coordinates: Float64Array.from(coordinates),
    columns: {
      Vm: {
        kind: 'numeric',
        values: new Float64Array(count * coordinates.length).fill(1),
        offset: 0,
        length: count * coordinates.length,
        rowStride: 1,
        frameStride: count,
      },
    },
  }
}

describe('actual sample coverage', () => {
  it('distinguishes an empty component type from missing topology rows', () => {
    const fields = [
      { from: 'Bus', select: ['x'] },
      { from: 'EmptyType', select: ['x'] },
    ]
    expect(() => validateStatics(base(), fields, { Bus: 2, EmptyType: 0 })).not.toThrow()
    expect(() => validateStatics(base(), fields, { Bus: 3, EmptyType: 0 })).toThrow(
      'Incomplete row space',
    )
    expect(() => validateStatics(base(), fields, { Bus: 2, EmptyType: 1 })).toThrow(
      'Missing row space',
    )
  })
  it('guards the installed-model failure before an uncovered point query is opened', async () => {
    const data = appendData(base(), [batch(100, [5, 6])])
    expect(coversTime(data, 'Bus', 'Vm', 0)).toBe(false)
    expect(coversTime(data, 'Bus', 'Vm', 5.5)).toBe(true)
    expect(coversTime(data, 'Bus', 'Vm', 20)).toBe(false)
    const reader = createReader()
    const scope = reader.open({ at: 0 })
    try {
      await expect(
        (async () => {
          for await (const _block of scope.fields({
            source: base(),
            from: 'Bus',
            rows: { ...rows, index },
            fields: { x: 'x', value: { source: data, from: 'Bus', field: 'Vm' } },
          })) {
            /* consume */
          }
        })(),
      ).rejects.toThrow('Query did not cover the requested draw rows')
    } finally {
      scope.close()
      reader.destroy()
    }
  })

  it('requires every requested row and every frame, including across differently tiled pages', () => {
    const expected = [
      {
        from: 'Bus',
        field: 'Vm',
        rows: { ...rows, index },
        first: 0,
        count: 4,
        domain: [0, 3] as const,
      },
    ]
    const partial = appendData(base(), [batch(0, [0, 1, 2, 3], 0, 1)])
    expect(() => validateCoverage(partial, expected)).toThrow('Incomplete sample coverage')
    const complete = appendData(base(), [
      batch(0, [0, 1], 0, 1),
      batch(0, [0, 1], 1, 1),
      batch(2, [2, 3]),
    ])
    expect(() => validateCoverage(complete, expected)).not.toThrow()
    const gap = appendData(base(), [batch(0, [0]), batch(2, [2, 3])])
    expect(coversTime(gap, 'Bus', 'Vm', 1)).toBe(false)
    expect(() => validateCoverage(gap, expected)).toThrow('Incomplete sample coverage')
  })

  it('unions IDs and physical selections without silently dropping either', () => {
    const data = base()
    const selected = recordedSelection(
      data,
      [
        { from: 'Bus', select: ['Vm'], rows: { kind: 'ids', ids: ['Bus/1'] } },
        {
          from: 'Bus',
          select: ['Vm'],
          rows: { kind: 'indices', index, values: Uint32Array.of(1) },
        },
      ],
      'Bus',
      'Vm',
    )
    expect(selected).toMatchObject({ kind: 'range', offset: 0, count: 2, index })
    expect(coversRows([{ kind: 'indices', values: Uint32Array.of(0, 0) }], rows)).toBe(false)
    expect(
      coversRows([{ kind: 'range', offset: 0, count: 10 }], {
        kind: 'indices',
        values: Uint32Array.of(0, 4, 9),
      }),
    ).toBe(true)
  })

  it('measures appended pages as it would measure them all at once', () => {
    // Rows arrive in blocks of their own, frame 4 never arrives, and the last frames hold one row.
    const steps = [
      [batch(0, [0, 1], 0, 1), batch(0, [0, 1], 1, 1)],
      [batch(2, [2, 3])],
      [batch(5, [5, 6]), batch(7, [7, 8], 0, 1)],
      [batch(9, [9], 0, 1), batch(9, [9], 1, 1), batch(10, [10, 11])],
    ]
    const times = Array.from({ length: 25 }, (_, i) => i / 2)
    let grown = base()
    for (let step = 0; step < steps.length; step++) {
      grown = appendData(grown, steps[step]!)
      const whole = appendData(base(), steps.slice(0, step + 1).flat())
      for (const at of times)
        expect(coversTime(grown, 'Bus', 'Vm', at), `step ${step} at ${at}`).toBe(
          coversTime(whole, 'Bus', 'Vm', at),
        )
    }
    expect(coversInterval(grown, 'Bus', 'Vm', [0, 3])).toBe(true)
    expect(coversInterval(grown, 'Bus', 'Vm', [9, 11])).toBe(true)
    expect(coversInterval(grown, 'Bus', 'Vm', [3, 5])).toBe(false)
    expect(coversInterval(grown, 'Bus', 'Vm', [5, 9])).toBe(false)
  })

  it('loads both neighboring pages even when no sample lies inside the requested window', () => {
    const pages = [0, 10, 20, 30].map((t) => ({ domain: [t, t + 1] as const }))
    expect(pageWindow(pages, [5, 6])).toEqual([0, 2])
    expect(pageWindow(pages, [10, 20])).toEqual([0, 4])
    expect(pageWindow(pages, [40, 50])).toEqual([3, 4])
    expect(pageWindow(pages, [5, 6], 2)).toEqual([2, 2])
  })
})
