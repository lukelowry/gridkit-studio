import { setImmediate as yieldTurn } from 'node:timers/promises'

import { read } from '@latkit/model'

import { rowsOf } from '../shared/cells.js'
import {
  type AggregateQuery,
  type CaseQuery,
  type NeighborhoodQuery,
  pageOf,
} from '../shared/inspection.js'
import type { Case } from './case.js'

/** Filtering stays beside the case; agents receive an opaque selection instead of thousands of IDs. */
export async function selectIds(kase: Case, input: CaseQuery, signal: AbortSignal) {
  const ids: string[] = []
  for await (const block of read(
    kase.data,
    {
      kind: 'rows',
      from: input.from,
      select: [],
      ids: true,
      ...(input.ids ? { rows: { kind: 'ids', ids: input.ids } as const } : {}),
      ...(input.where ? { where: input.where } : {}),
    },
    { signal, maxBlockBytes: 256 << 10 },
  )) {
    if (block.kind === 'rows') for (const row of rowsOf([block])) ids.push(row.id!)
    await yieldTurn(undefined, { signal })
  }
  return ids
}

function staticField(kase: Case, from: string, field: string) {
  const definition = kase.schema.types[from]?.fields[field]
  if (!definition || definition.sampled) throw new Error('Choose static fields from inspect_case.')
  return definition
}

export async function aggregate(kase: Case, input: AggregateQuery, signal: AbortSignal) {
  const { offset, limit } = pageOf(input)
  if (!input.fields.length) throw new Error('Choose numeric fields to aggregate.')
  for (const field of input.fields) {
    const definition = staticField(kase, input.from, field)
    if (!['float64', 'int32', 'uint32'].includes(String(definition.type)))
      throw new Error('Aggregate numeric fields only: ' + field)
  }
  const group = input.groupBy ? staticField(kase, input.from, input.groupBy) : undefined
  const groups = new Map<
    string,
    {
      group: unknown
      count: number
      values: Record<
        string,
        { valid: number; missing: number; sum: number; min: number | null; max: number | null }
      >
    }
  >()
  const ids = await selectIds(kase, input, signal)
  const table = kase.table(input.from)
  for (let n = 0; n < ids.length; n++) {
    if (n % 1024 === 0) await yieldTurn(undefined, { signal })
    const row = kase.locate(ids[n]!)!.row
    let value = input.groupBy ? kase.cell(table, input.groupBy, row) : null
    if (
      group &&
      typeof group.type === 'object' &&
      group.type.kind === 'reference' &&
      typeof value === 'number'
    )
      value = kase.id(kase.table(group.type.to), value)
    const key = JSON.stringify(value)
    let bucket = groups.get(key)
    if (!bucket)
      groups.set(
        key,
        (bucket = {
          group: value,
          count: 0,
          values: Object.fromEntries(
            input.fields.map((field) => [
              field,
              { valid: 0, missing: 0, sum: 0, min: null, max: null },
            ]),
          ),
        }),
      )
    bucket.count++
    for (const field of input.fields) {
      const stats = bucket.values[field]!
      const v = kase.cell(table, field, row)
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        stats.missing++
        continue
      }
      stats.valid++
      stats.sum += v
      stats.min = stats.min === null ? v : Math.min(stats.min, v)
      stats.max = stats.max === null ? v : Math.max(stats.max, v)
    }
  }
  const rows = [...groups.values()].slice(offset, offset + limit).map((group) => ({
    ...group,
    values: Object.fromEntries(
      Object.entries(group.values).map(([field, stats]) => [
        field,
        { ...stats, mean: stats.valid ? stats.sum / stats.valid : null },
      ]),
    ),
  }))
  return {
    revision: { uri: input.uri, version: input.version },
    fingerprint: kase.version,
    from: input.from,
    matched: ids.length,
    units: Object.fromEntries(
      input.fields.map((field) => [
        field,
        kase.schema.types[input.from]!.fields[field]!.unit ?? null,
      ]),
    ),
    groupBy: input.groupBy ?? null,
    rows,
    offset,
    total: groups.size,
    nextOffset: offset + rows.length < groups.size ? offset + rows.length : null,
  }
}

type Edge = { from: string; field: string; to: string; direction: string }
const graphs = new WeakMap<Case, Map<string, Edge[]>>()

/** Every port connection of `kase`, by the elements at its ends; built once per parsed case. */
async function graphOf(kase: Case, signal: AbortSignal): Promise<Map<string, Edge[]>> {
  const cached = graphs.get(kase)
  if (cached) return cached
  const graph = new Map<string, Edge[]>()
  let n = 0
  for (const table of kase.tables.values())
    for (let row = 0; row < table.records.length; row++) {
      if (n++ % 1024 === 0) await yieldTurn(undefined, { signal })
      const from = kase.id(table, row)
      for (const port of table.shape.ports) {
        const target = kase.cell(table, port.name, row)
        if (typeof target !== 'number') continue
        const to = kase.id(kase.table(port.definition.type.to), target)
        const edge = {
          from,
          field: port.name,
          to,
          direction: port.definition.direction ?? 'both',
        }
        for (const id of [from, to]) {
          const edges = graph.get(id) ?? []
          edges.push(edge)
          graph.set(id, edges)
        }
      }
    }
  graphs.set(kase, graph)
  return graph
}

/** The nearest elements of the `drawn` types that stand for `id` in a view: none when the view
 *  draws it, else the buses its ports reach, through the devices its control ports drive. */
export async function anchors(
  kase: Case,
  input: { id: string; drawn: readonly string[] },
  signal: AbortSignal,
): Promise<string[]> {
  if (!kase.locate(input.id)) throw new Error('Unknown element: ' + input.id)
  const graph = await graphOf(kase, signal)
  const drawn = new Set(input.drawn)
  const typeOf = (id: string) => id.slice(0, id.indexOf('/'))
  const found: string[] = []
  const seen = new Set([input.id])
  let frontier = drawn.has(typeOf(input.id)) ? [] : [input.id]
  while (frontier.length && !found.length) {
    const next: string[] = []
    for (const id of frontier)
      for (const edge of graph.get(id) ?? []) {
        const other = edge.from === id ? edge.to : edge.from
        if (seen.has(other)) continue
        seen.add(other)
        ;(drawn.has(typeOf(other)) ? found : next).push(other)
      }
    frontier = next
  }
  return found
}

/** Structural port adjacency only: a path does not establish power flow or causal influence. */
export async function neighborhood(kase: Case, input: NeighborhoodQuery, signal: AbortSignal) {
  const { offset, limit } = pageOf(input)
  if (!Number.isSafeInteger(input.hops) || input.hops < 0)
    throw new Error('Use a nonnegative hop count.')
  if (!kase.locate(input.id)) throw new Error('Unknown element: ' + input.id)
  const graph = await graphOf(kase, signal)
  const visited = new Map([[input.id, 0]])
  const queue = [input.id]
  const edges = new Set<Edge>()
  for (let n = 0; n < queue.length; n++) {
    if (n % 1024 === 0) await yieldTurn(undefined, { signal })
    const id = queue[n]!
    const depth = visited.get(id)!
    if (depth >= input.hops) continue
    for (const edge of graph.get(id) ?? []) {
      if (edge.to.startsWith(kase.catalog.bus + '/') !== (input.network === 'electrical')) continue
      edges.add(edge)
      const next = edge.from === id ? edge.to : edge.from
      if (!visited.has(next)) {
        visited.set(next, depth + 1)
        queue.push(next)
      }
    }
  }
  const all = [...edges]
  return {
    revision: { uri: input.uri, version: input.version },
    fingerprint: kase.version,
    root: input.id,
    network: input.network,
    hops: input.hops,
    semantics:
      'One hop is one device port connection; traversal is undirected. Direction describes the port, not measured flow.',
    nodes: visited.size,
    rows: all.slice(offset, offset + limit),
    offset,
    total: all.length,
    nextOffset: offset + limit < all.length ? offset + limit : null,
  }
}
