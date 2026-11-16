import { type Entity, entityLabel } from '../shared/document.js'
import type { Case, Table } from './case.js'
import { isValid } from './columns.js'
import { STEP_RECORDS, Turns } from './turns.js'

/** Every port connection of a case in compressed sparse rows: each row's neighbors in both
 *  directions, as a table number and a row. */
interface Adjacency {
  readonly tables: readonly Table[]
  /** Per table, where each row's neighbors start in `table` and `row`. The last is the total. */
  readonly starts: readonly Uint32Array[]
  readonly table: Uint32Array
  readonly row: Uint32Array
}

const adjacencies = new WeakMap<Case, Promise<Adjacency>>()

/** Every valid port reference in `kase`, as the source table and row, then the target table and
 *  row. */
function* references(kase: Case, numbers: ReadonlyMap<string, number>) {
  for (const [from, table] of [...kase.tables.values()].entries())
    for (const port of table.shape.ports) {
      const to = numbers.get(port.definition.target)
      const column = table.fields.get(port.name)
      if (to === undefined || !column) continue
      for (const [c, value] of column.chunks.entries()) {
        const chunk = value as Float64Array
        const first = column.starts[c]!
        for (let at = 0; at < chunk.length; at++)
          if (isValid(chunk, at))
            yield [
              from,
              first + at,
              to,
              kase.rowOf(kase.table(port.definition.target), chunk[at]!),
            ] as const
      }
    }
}

/** The connections of `kase`, built once in slices and shared by every caller. */
function adjacencyOf(kase: Case): Promise<Adjacency> {
  let built = adjacencies.get(kase)
  if (!built) adjacencies.set(kase, (built = build(kase)))
  return built
}

async function build(kase: Case): Promise<Adjacency> {
  // Shared by every caller, so it never aborts. A caller that cancels stops waiting instead.
  const work = new Turns()
  const tables = [...kase.tables.values()]
  const numbers = new Map(tables.map((table, n) => [table.shape.type, n]))
  // Count each row's neighbors, then place them, for both ends of each connection.
  const counts = tables.map((table) => new Uint32Array(table.records.length + 1))
  let step = 0
  for (const [from, row, to, target] of references(kase, numbers)) {
    if ((++step & STEP_RECORDS) === 0) await work.step()
    counts[from]![row + 1]!++
    counts[to]![target + 1]!++
  }
  let total = 0
  const starts = counts.map((count) => {
    count[0] = total
    for (let r = 1; r < count.length; r++) count[r] = total += count[r]!
    return count
  })
  const placed = starts.map((start) => start.slice(0, -1))
  const table = new Uint32Array(total)
  const row = new Uint32Array(total)
  const link = (from: number, at: number, to: number, target: number) => {
    const slot = placed[from]![at]!++
    table[slot] = to
    row[slot] = target
  }
  for (const [from, at, to, target] of references(kase, numbers)) {
    if ((++step & STEP_RECORDS) === 0) await work.step()
    link(from, at, to, target)
    link(to, target, from, at)
  }
  return { tables, starts, table, row }
}

/** `entity` as the Network selects it: the element itself when the Network draws its type, else the
 *  nearest drawn elements reachable through port connections. Empty when there are none. */
export async function networkSelectionOf(
  kase: Case,
  entity: Entity,
  signal: AbortSignal,
): Promise<Entity[]> {
  const located = kase.locate(entity)
  if (!located) throw new Error('Unknown element: ' + entityLabel(entity))
  const { vertices, edges } = kase.definition.drawing
  const types = new Set([...vertices, ...edges].map((item) => item.table))
  if (types.has(entity.table)) return [{ table: entity.table, id: entity.id }]
  const adjacency = await new Turns(signal).wait(adjacencyOf(kase))
  const { tables, starts } = adjacency
  const drawn = new Set(tables.flatMap((table, n) => (types.has(table.shape.type) ? [n] : [])))
  /** A table number and row packed into one number. */
  const key = (t: number, r: number) => t * 0x1_0000_0000 + r
  const start = key(tables.indexOf(located.table), located.row)
  const seen = new Set([start])
  const found: number[] = []
  let frontier = [start]
  while (frontier.length && !found.length) {
    const next: number[] = []
    for (const at of frontier) {
      const t = Math.floor(at / 0x1_0000_0000)
      const r = at % 0x1_0000_0000
      for (let slot = starts[t]![r]!; slot < starts[t]![r + 1]!; slot++) {
        const other = key(adjacency.table[slot]!, adjacency.row[slot]!)
        if (seen.has(other)) continue
        seen.add(other)
        ;(drawn.has(adjacency.table[slot]!) ? found : next).push(other)
      }
    }
    frontier = next
  }
  return found.map((at) => kase.entity(tables[Math.floor(at / 0x1_0000_0000)]!, at % 0x1_0000_0000))
}
