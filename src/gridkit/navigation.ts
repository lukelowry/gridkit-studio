import { findNodeAtLocation, getLocation, parseTree } from 'jsonc-parser'

import type { SourceContext } from '../shared/messages.js'
import type { Case } from './case.js'
import { CASE, type Catalog, type FieldPlan, SIGNAL } from './definition.js'
import { nativePath, recordOf, sourceRange, textOffset } from './edits.js'

/** What is at UTF-16 `offset`: its row and field, their range, the row a reference names, and the
 *  fields that complete beside it. */
export function sourceContext(kase: Case, offset: number): SourceContext {
  for (const table of kase.tables.values()) {
    if (!table.shape.array) continue
    const records = kase.arrays[table.shape.array]!
    const indexes = table.records
    let low = 0
    let high = indexes.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (textOffset(kase, records.starts[indexes[mid]!]!) <= offset) low = mid + 1
      else high = mid
    }
    const row = low - 1
    if (row < 0 || offset > textOffset(kase, records.ends[indexes[row]!]!)) continue
    const id = kase.id(table, row)
    const record = recordOf(kase, id)
    const location = getLocation(record.text, offset - record.offset)
    const path = location.path.filter((key): key is string => typeof key === 'string')
    const group = path.slice(0, -1)
    const plans = [...table.shape.plan.values()]
    const plan = plans.find((plan) => JSON.stringify(nativePath(plan)) === JSON.stringify(path))
    const range = plan
      ? sourceRange(kase, id, plan.name)
      : { offset: record.offset, length: record.text.length }
    let reference: string | undefined
    if (
      plan &&
      typeof plan.definition.type === 'object' &&
      plan.definition.type.kind === 'reference'
    ) {
      const node = findNodeAtLocation(parseTree(record.text)!, path)
      if (typeof node?.value === 'number') reference = plan.definition.type.to + '/' + node.value
    }
    return {
      element: { id, ...(plan ? { field: plan.name } : {}) },
      type: table.shape.type,
      range,
      reference,
      completions: plans
        .filter(
          (plan) =>
            !plan.definition.sampled &&
            JSON.stringify(nativePath(plan).slice(0, -1)) === JSON.stringify(group),
        )
        .map((plan) => completion(nativePath(plan).at(-1)!, plan)),
    }
  }
  return { completions: [] }
}

/** The fields that complete at `offset`, from `text` alone, so it may be invalid JSON. */
export function completionsAt(
  catalog: Catalog,
  text: string,
  offset: number,
): SourceContext['completions'] {
  const location = getLocation(text, offset)
  if (!location.isAtPropertyKey) return []
  const path = location.path
  const array = typeof path[0] === 'string' ? path[0] : ''
  const row = typeof path[1] === 'number' ? path[1] : undefined
  const tree = parseTree(text)
  const type =
    array === 'buses'
      ? catalog.bus
      : array === 'signals'
        ? SIGNAL
        : row !== undefined && tree
          ? findNodeAtLocation(tree, [array, row, 'class'])?.value
          : CASE
  const shape = catalog.shapes.get(type)
  if (!shape) return []
  const group = path.slice(row === undefined ? 0 : 2, -1)
  const fields = [...shape.plan.values()]
    .filter((plan) => !plan.definition.sampled)
    .map((plan) => [nativePath(plan), plan] as const)
    .filter(([path]) => JSON.stringify(path.slice(0, -1)) === JSON.stringify(group))
    .map(([path, plan]) => completion(path.at(-1)!, plan))
  return [...new Map(fields.map((field) => [field.name, field])).values()]
}

/** The completion `name` offers for `plan`: its type and unit, and its description. */
function completion(name: string, plan: FieldPlan): SourceContext['completions'][number] {
  const { type, unit, description } = plan.definition
  return {
    name,
    detail: (typeof type === 'string' ? type : type.kind) + (unit ? ' [' + unit + ']' : ''),
    description,
  }
}
