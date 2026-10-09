import type { Positions } from '@latkit/gpu'
import { type Data, type NumericColumn, read, type RowBatch, textColumn } from '@latkit/model'
import { describe, expect, it, vi } from 'vitest'

import type { Requests, Summary } from '../shared/messages.js'
import { Rows } from './rows.js'

const index = { source: 'case', type: 'Bus', version: '1' }
/** Where the diagram places its blocks, as the worker answers. */
const placed: Record<string, Positions> = {}
const schema = {
  types: { Bus: { fields: { kV: { type: 'float64' }, area: { type: 'float64' } } } },
} as const
/** The case at `version`, as a view is told of it. */
const summary = (version: number) =>
  ({ uri: 'file:///case', version, fingerprint: String(version), schema }) as unknown as Summary
const kV = { from: 'Bus', select: ['kV'] }
const both = { from: 'Bus', select: ['kV', 'area'] }

/** A case worker that answers with two buses' fields, keeping what it was asked. At version `v`,
 *  a bus's field holds `v` and `v + 0.5`. With `gate`, it waits for it before answering. */
function worker(gate?: () => Promise<void>) {
  const asked: Requests['rows']['input'][] = []
  const request = vi.fn(async (input: Requests['rows']['input']) => {
    asked.push(input)
    await gate?.()
    return input.fields.map(({ select }): RowBatch => ({
      kind: 'rows',
      index,
      rows: { kind: 'range', offset: 0, count: 2 },
      ids: textColumn(['Bus/1', 'Bus/2']),
      columns: Object.fromEntries(
        select.map((name) => [
          name,
          {
            kind: 'numeric',
            values: Float64Array.of(input.version, input.version + 0.5),
            offset: 0,
            length: 2,
          },
        ]),
      ),
    }))
  })
  return { asked, request }
}

/** The rows a view holds, asking `request`. */
function rowsOf(request: ReturnType<typeof worker>['request']) {
  const changed = vi.fn()
  const report = vi.fn()
  const presentation = vi.fn(async () => placed)
  const rows = new Rows({ request, presentation, changed, report })
  return { rows, changed, report, presentation }
}

/** `field` of each bus in `data`. */
async function values(data: Data, field: string) {
  const found: number[] = []
  for await (const block of read(data, { kind: 'rows', from: 'Bus', select: [field] })) {
    const column = block.columns[field] as NumericColumn
    for (let i = 0; i < column.length; i++) found.push(column.values[column.offset + i]!)
  }
  return found
}

describe('the rows a view holds', () => {
  it('asks only for the fields it lacks, and keeps those it has while the revision stands', async () => {
    const { asked, request } = worker()
    const { rows, changed } = rowsOf(request)
    rows.want({ summary: summary(1) }, [kV])
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
    expect(asked.map(({ fields }) => fields)).toEqual([[kV]])
    expect(await values(rows.snapshot!.data, 'kV')).toEqual([1, 1.5])
    // Mapping another field asks for it alone.
    rows.want({ summary: summary(1) }, [both])
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
    expect(asked.at(-1)!.fields).toEqual([{ from: 'Bus', select: ['area'] }])
    expect(rows.snapshot!.fields).toEqual(new Set(['Bus.kV', 'Bus.area']))
    expect(await values(rows.snapshot!.data, 'area')).toEqual([1, 1.5])
    // A mapping taken away changes nothing held, and mapping it again asks for nothing.
    rows.want({ summary: summary(1) }, [kV])
    rows.want({ summary: summary(1) }, [both])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(asked).toHaveLength(2)
  })

  it('asks for what the view came to want while an ask was under way, once it ends', async () => {
    const { asked, request } = worker()
    const { rows, changed } = rowsOf(request)
    rows.want({ summary: summary(1) }, [kV])
    rows.want({ summary: summary(1) }, [both])
    await vi.waitFor(() => expect(rows.snapshot?.fields.size).toBe(2))
    expect(asked.map(({ fields }) => fields)).toEqual([[kV], [{ from: 'Bus', select: ['area'] }]])
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('starts over for another revision, showing the last rows until its own come', async () => {
    let open!: () => void
    const { asked, request } = worker(() =>
      asked.at(-1)!.version === 2 ? new Promise((resolve) => (open = resolve)) : Promise.resolve(),
    )
    const { rows } = rowsOf(request)
    rows.want({ summary: summary(1) }, [both])
    await vi.waitFor(() => expect(rows.snapshot?.revision.version).toBe(1))
    rows.want({ summary: summary(2) }, [kV])
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    // The revision before stays on show while the new one's rows are on their way.
    expect(rows.snapshot!.revision.version).toBe(1)
    expect(asked[1]!.fields).toEqual([kV])
    open()
    await vi.waitFor(() => expect(rows.snapshot!.revision.version).toBe(2))
    expect(rows.snapshot!.fields).toEqual(new Set(['Bus.kV']))
    expect(await values(rows.snapshot!.data, 'kV')).toEqual([2, 2.5])
  })

  it('asks where the diagram places its blocks once a revision, when asked to', async () => {
    const { request } = worker()
    const { rows, presentation } = rowsOf(request)
    rows.want({ summary: summary(1) }, [kV], true)
    await vi.waitFor(() => expect(rows.snapshot?.presentation).toBe(placed))
    rows.want({ summary: summary(1) }, [both], true)
    await vi.waitFor(() => expect(rows.snapshot?.fields.size).toBe(2))
    expect(presentation).toHaveBeenCalledOnce()
    expect(rows.snapshot!.presentation).toBe(placed)
  })

  it('reports a failed ask once, and asks again only when the view is reloaded', async () => {
    let fail = true
    const { asked, request } = worker(async () => {
      if (fail) throw Object.assign(new Error('Unreadable'), { code: 'io' })
    })
    const { rows, report } = rowsOf(request)
    rows.want({ summary: summary(1) }, [kV])
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce())
    rows.want({ summary: summary(1) }, [kV])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(asked).toHaveLength(1)
    fail = false
    rows.retry()
    await vi.waitFor(() => expect(rows.snapshot?.fields).toEqual(new Set(['Bus.kV'])))
    expect(report).toHaveBeenCalledOnce()
    // A revision read again since it was asked for is no failure: the newer one is asked for.
    const stale = worker(async () => {
      throw Object.assign(new Error('The document changed.'), { code: 'stale' })
    })
    const quiet = rowsOf(stale.request)
    quiet.rows.want({ summary: summary(1) }, [kV])
    await vi.waitFor(() => expect(stale.asked).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(quiet.report).not.toHaveBeenCalled()
  })
})
