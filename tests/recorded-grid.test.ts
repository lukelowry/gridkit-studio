import { expect, it } from 'vitest'

import { CaseFields } from '../src/fields.js'
import { parse as parseCase } from '../src/gridkit/parse.js'
import { recordedGrid } from '../src/table/grid.js'
const parse = (bytes: Uint8Array) => parseCase(bytes).model
import type { CsvSource } from '../src/csv/source.js'
import { caseText } from './support/case.js'
it('filters and sorts recorded fields at the same frame without retaining a class-by-field table', async () => {
  const model = parse(
    new TextEncoder().encode(
      caseText({
        buses: [
          { number: 1, mon: ['Vm'] },
          { number: 2, mon: ['Vm'] },
        ],
      }),
    ),
  )
  const value = (time: number, index: number) =>
    time ? [42.123456789, 7][index] : [1, 987.654321][index]
  const recording = {
    has: (field: { id: string }) => field.id === 'Vm',
    locate: async (time: number) => time,
    frame: async (time: number) => ({
      index: time,
      time,
      values: async (_: unknown, elements: number[]) =>
        Float64Array.from(elements, (index) => value(time, index)),
    }),
    cellsAt: async (time: number, _: unknown, elements: number[]) =>
      Float64Array.from(elements, (index) => value(time, index)),
  } as unknown as CsvSource
  const fields = new CaseFields(model, () => recording)
  const grid = recordedGrid(await model.load('bus'), fields, 'bus')
  try {
    const window = await grid.window('987.654321', null, 0, 10)
    expect(window.rows.map((row) => row.index)).toEqual([1])
    expect(await grid.locate(1, '987.654321', null)).toBe(0)
    fields.setTime(1)
    expect((await grid.window('987.654321', null, 0, 10)).total).toBe(0)
    expect(
      (await grid.window('', { column: '@signal:Vm', dir: 'asc' }, 0, 10)).rows.map(
        (row) => row.index,
      ),
    ).toEqual([1, 0])
    expect((await grid.window('42.123456789', null, 0, 10)).rows.map((row) => row.index)).toEqual([
      0,
    ])
  } finally {
    grid.dispose()
  }
})
