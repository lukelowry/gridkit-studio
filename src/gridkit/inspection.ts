import { setImmediate as yieldTurn } from 'node:timers/promises'

import type { Case } from './case.js'

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
