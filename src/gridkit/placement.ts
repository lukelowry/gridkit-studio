import type { FieldValues } from '@latkit/model'

import { networkOf } from '../shared/schema.js'
import type { Case } from './case.js'

const cache = new WeakMap<Case, Record<string, FieldValues>>()
// A deterministic layout for a network with no places of its own. Bound work and yield in the data worker.
export async function placement(
  kase: Case,
  signal: AbortSignal,
): Promise<Record<string, FieldValues>> {
  const existing = cache.get(kase)
  if (existing) return existing
  const drawn = networkOf(kase.schema)
  const banks: { type: string; base: number; count: number }[] = []
  let count = 0
  for (const type of drawn.vertices) {
    const table = kase.table(type)
    const field = kase.schema.types[type]!.spatial!.field
    for (let row = 0; row < table.records.length; row++) {
      const value = kase.cell(table, field, row)
      if (Array.isArray(value) && value.every(Number.isFinite)) {
        cache.set(kase, {})
        return {}
      }
    }
    banks.push({ type, base: count, count: table.records.length })
    count += table.records.length
  }
  const offsets = new Map(banks.map((bank) => [bank.type, bank.base]))
  const pairs: [number, number][] = []
  for (const edge of drawn.edges) {
    if (!edge.ends) continue
    const table = kase.table(edge.type)
    for (let row = 0; row < table.records.length; row++) {
      const ends = edge.ends.map((field) => {
        const plan = table.shape.plan.get(field)!
        const target =
          typeof plan.definition.type === 'object' && plan.definition.type.kind === 'reference'
            ? offsets.get(plan.definition.type.to)
            : undefined
        const at = kase.cell(table, field, row)
        return typeof at === 'number' && target !== undefined ? at + target : undefined
      })
      if (ends[0] !== undefined && ends[1] !== undefined && ends[0] !== ends[1])
        pairs.push([ends[0], ends[1]])
    }
  }
  const points = count > 2000 ? circle(count) : await settle(count, pairs, signal)
  signal.throwIfAborted()
  const result = Object.fromEntries(
    banks.map(({ type, base, count }) => {
      const table = kase.data.tables[type]!
      const values = points.slice(base * 2, (base + count) * 2)
      return [
        type,
        {
          index: table.index,
          rows: table.rows,
          values: {
            kind: 'vector' as const,
            size: 2,
            offset: 0,
            length: count,
            values: { kind: 'numeric' as const, offset: 0, length: values.length, values },
          },
        },
      ]
    }),
  )
  cache.set(kase, result)
  return result
}
/** `count` points evenly on a unit circle. */
function circle(count: number): Float64Array {
  const points = new Float64Array(count * 2)
  for (let k = 0; k < count; k++) {
    const angle = (2 * Math.PI * k) / Math.max(1, count)
    points[k * 2] = Math.cos(angle)
    points[k * 2 + 1] = Math.sin(angle)
  }
  return points
}

/** Where `count` vertices joined by `pairs` settle: they repel one another, edges pull their ends
 *  together, and the moves cool each round (Fruchterman and Reingold). */
async function settle(
  count: number,
  pairs: readonly (readonly [number, number])[],
  signal: AbortSignal,
): Promise<Float64Array> {
  const rounds = Math.min(300, Math.max(12, Math.floor(24_000_000 / Math.max(1, count * count))))
  const points = circle(count)
  const ideal = Math.sqrt(4 / Math.max(1, count))
  const moves = new Float64Array(count * 2)
  for (let round = 0; round < rounds; round++) {
    if (round % 4 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      signal.throwIfAborted()
    }
    moves.fill(0)
    for (let a = 0; a < count; a++)
      for (let b = a + 1; b < count; b++) {
        const dx = points[a * 2]! - points[b * 2]!
        const dy = points[a * 2 + 1]! - points[b * 2 + 1]!
        const push = (ideal * ideal) / Math.max(1e-12, dx * dx + dy * dy)
        moves[a * 2]! += dx * push
        moves[a * 2 + 1]! += dy * push
        moves[b * 2]! -= dx * push
        moves[b * 2 + 1]! -= dy * push
      }
    for (const [a, b] of pairs) {
      const dx = points[a * 2]! - points[b * 2]!
      const dy = points[a * 2 + 1]! - points[b * 2 + 1]!
      const pull = Math.hypot(dx, dy) / ideal
      moves[a * 2]! -= dx * pull
      moves[a * 2 + 1]! -= dy * pull
      moves[b * 2]! += dx * pull
      moves[b * 2 + 1]! += dy * pull
    }
    const heat = 0.1 * (1 - round / rounds) + 0.001
    for (let k = 0; k < count; k++) {
      const length = Math.max(1e-9, Math.hypot(moves[k * 2]!, moves[k * 2 + 1]!))
      const step = Math.min(length, heat) / length
      points[k * 2]! += moves[k * 2]! * step
      points[k * 2 + 1]! += moves[k * 2 + 1]! * step
    }
  }
  return points
}
