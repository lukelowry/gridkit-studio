import { type Fields, type Id, Patch, type Reference, type Values } from 'latkit'

import {
  ENTRY_BYTES,
  PAGE_BYTES,
  type ProjectionCursor,
  type ProjectionPage,
  type ProjectionSelection,
} from '../shared/data.js'
import type { Case, Part, Table } from './case.js'
import { included, projectionKey, projectionPage } from './projection.js'
import { Turns } from './turns.js'

interface DirtyTable {
  removed: Id[]
  added: Id[]
  touched: Id[]
}
const plans = new WeakMap<Case, WeakMap<Case, Map<string, DirtyTable>>>()

function first(records: Uint32Array, value: number): number {
  let lo = 0
  let hi = records.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (records[mid]! < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Retained parsed parts are identity-equal even when their source byte offsets move. */
function dirtyRows(kase: Case, table: Table, parts: readonly Part[]): Id[] {
  if (!table.shape.array) return kase.projected().tables.get(table.shape.type)!.ids.slice()
  const rows: Id[] = []
  for (const part of parts) {
    if (part.range.array !== table.shape.array) continue
    const end = part.range.first + part.parsed.codes.length
    for (
      let row = first(table.records, part.range.first);
      row < table.records.length && table.records[row]! < end;
      row++
    )
      rows.push(kase.native(table, row))
  }
  return rows
}

function dirty(before: Case, after: Case): Map<string, DirtyTable> {
  let bases = plans.get(after)
  if (!bases) plans.set(after, (bases = new WeakMap()))
  const known = bases.get(before)
  if (known) return known
  const oldParts = new Set(before.parts.map((part) => part.parsed))
  const newParts = new Set(after.parts.map((part) => part.parsed))
  const removed = before.parts.filter((part) => !newParts.has(part.parsed))
  const changed = after.parts.filter((part) => !oldParts.has(part.parsed))
  const plan = new Map<string, DirtyTable>()
  for (const [name, table] of after.tables) {
    const touched = dirtyRows(after, table, changed)
    const previous = before.tables.get(name)
    plan.set(name, {
      touched,
      added: touched.filter((id) => !previous || before.rowOf(previous, id) < 0),
      removed: previous
        ? dirtyRows(before, previous, removed).filter((id) => after.rowOf(table, id) < 0)
        : [],
    })
  }
  bases.set(before, plan)
  return plan
}

function scalar(values: Values | Reference): unknown {
  return 'reference' in values
    ? 'count' in values.ids
      ? values.ids.count
        ? 0
        : null
      : values.ids[0]
    : values[0]
}
function same(a: unknown, b: unknown): boolean {
  return (
    Object.is(a, b) ||
    (!!a &&
      !!b &&
      typeof a === 'object' &&
      typeof b === 'object' &&
      JSON.stringify(a) === JSON.stringify(b))
  )
}

/** One bounded delta page; changes are located from parser parts, never a whole-field diff. */
export async function deltaProjectionPage(
  before: Case,
  after: Case,
  selection: readonly ProjectionSelection[],
  base: string,
  cursor: ProjectionCursor | undefined,
  signal: AbortSignal,
): Promise<ProjectionPage> {
  const document = after.projected()
  if (
    projectionKey(before.projected(), selection) !== base ||
    JSON.stringify(before.definition) !== JSON.stringify(after.definition)
  ) {
    return projectionPage(document, selection, cursor, signal)
  }
  const key = projectionKey(document, selection)
  const tables = included(document, selection)
  const plan = dirty(before, after)
  const referencesChanged = new Set(
    tables.flatMap(([name, fields]) => {
      const definition = document.definition.tables.find((table) => table.name === name)!
      return fields.some((field) => {
        const target = definition.fields.find((item) => item.name === field)?.target
        const changed = target && plan.get(target)
        return changed && (changed.added.length || changed.removed.length)
      })
        ? [name]
        : []
    }),
  )
  let { phase, table: index, offset } = cursor ?? { phase: 'removals', table: 0, offset: 0 }
  const phases = ['removals', 'identities', 'fields'] as const
  if (
    !phases.includes(phase) ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > tables.length ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new Error('Invalid projection cursor.')
  const turns = new Turns(signal)
  for (;;) {
    await turns.step()
    if (index === tables.length) {
      const nextPhase = phases[phases.indexOf(phase) + 1]
      if (!nextPhase) return { key, base, bytes: new Patch('case').toBytes() }
      phase = nextPhase
      index = 0
      offset = 0
      continue
    }
    const [name, fields] = tables[index]!
    const changed = plan.get(name)!
    const ids =
      phase === 'removals'
        ? changed.removed
        : phase === 'identities'
          ? changed.added
          : fields.length
            ? referencesChanged.has(name)
              ? document.tables.get(name)!.ids
              : changed.touched
            : []
    if (offset > ids.length) throw new Error('Projection cursor exceeds its table.')
    if (offset === ids.length) {
      index++
      offset = 0
      continue
    }
    let count = Math.min(4096, ids.length - offset)
    let bytes: Uint8Array
    for (;;) {
      const patch = new Patch('case')
      const page = ids.slice(offset, offset + count)
      if (phase === 'removals') patch.remove(name, page)
      else if (phase === 'identities') patch.set(name, page)
      else {
        const source = document.tables.get(name)!
        const previous = before.projected().tables.get(name)!
        for (const id of page) {
          const row = after.rowOf(after.table(name), id)
          const old = before.rowOf(before.table(name), id)
          const values: Record<string, Fields[string]> = {}
          for (const field of fields) {
            const next = source.read(field, row, 1)
            if (old < 0 || !same(scalar(next), scalar(previous.read(field, old, 1))))
              values[field] = next
          }
          if (Object.keys(values).length) patch.set(name, [id], values)
        }
      }
      bytes = patch.toBytes()
      signal.throwIfAborted()
      if (bytes.byteLength <= PAGE_BYTES) break
      if (count === 1) {
        if (bytes.byteLength > ENTRY_BYTES)
          throw Object.assign(new Error('A projected row exceeds 16 MiB.'), { code: 'limit' })
        break
      }
      count = Math.max(1, Math.floor(count / 2))
      await turns.step()
    }
    offset += count
    if (offset === ids.length) {
      index++
      offset = 0
    }
    return { key, base, bytes, next: { phase, table: index, offset } }
  }
}
