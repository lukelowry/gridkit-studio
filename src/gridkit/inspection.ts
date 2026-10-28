import type { Entity } from '../shared/document.js'
import type { Case, Table } from './case.js'
import { isValid } from './columns.js'
import { STEP_RECORDS, Turns } from './turns.js'

/** Every port connection of a case, by row: the rows each row's ports name, and the rows that name
 *  it, each as its table's number and its row there. */
interface Adjacency {
  /** The case's tables, by number. */
  readonly tables: readonly Table[]
  /** Per table, where each row's neighbors start in `table` and `row`; the last is how many. */
  readonly starts: readonly Uint32Array[]
  readonly table: Uint16Array
  readonly row: Uint32Array
}

const adjacencies = new WeakMap<Case, Promise<Adjacency>>()

/** Each valid reference of every port of `kase`: the table and row that names, and the table and
 *  row named. */
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

/** The connections of `kase`, built once a slice at a time, and shared by whoever asks meanwhile. */
function adjacencyOf(kase: Case): Promise<Adjacency> {
  let built = adjacencies.get(kase)
  if (!built) adjacencies.set(kase, (built = build(kase)))
  return built
}

async function build(kase: Case): Promise<Adjacency> {
  // Shared by every asker, so none lets go of it alone: each stops waiting instead.
  const work = new Turns()
  const tables = [...kase.tables.values()]
  const numbers = new Map(tables.map((table, n) => [table.shape.type, n]))
  // Each row's neighbors counted, then placed, both ends of each connection alike.
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
  const table = new Uint16Array(total)
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

/** The nearest elements of the `drawn` types that stand for `id` in a view: none when the view
 *  draws it, else the buses its ports reach, through the devices its control ports drive. */
export async function anchors(
  kase: Case,
  input: { entity: Entity; drawn: readonly string[] },
  signal: AbortSignal,
): Promise<Entity[]> {
  const located = kase.locate(input.entity)
  if (!located) throw new Error('Unknown element: ' + input.entity)
  if (input.drawn.includes(input.entity.table)) return []
  const adjacency = await new Turns(signal).wait(adjacencyOf(kase))
  const { tables, starts } = adjacency
  const drawn = new Set(
    tables.flatMap((table, n) => (input.drawn.includes(table.shape.type) ? [n] : [])),
  )
  /** A row, as one number: its table's number, then its row there. */
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
