import { findNodeAtLocation, getLocation, parseTree } from 'jsonc-parser'

import type { SourceContext } from '../shared/messages.js'
import type { Case } from './case.js'
import type { Catalog } from './definition.js'
import { nativePath, recordOf, sourceRange, textOffset } from './edits.js'
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
    const plan = plans.find(
      (plan) => JSON.stringify(nativePath(table.shape, plan)) === JSON.stringify(path),
    )
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
            JSON.stringify(nativePath(table.shape, plan).slice(0, -1)) === JSON.stringify(group),
        )
        .map((plan) => ({
          name: nativePath(table.shape, plan).at(-1)!,
          detail:
            (typeof plan.definition.type === 'string'
              ? plan.definition.type
              : plan.definition.type.kind) +
            (plan.definition.unit ? ' [' + plan.definition.unit + ']' : ''),
          description: plan.definition.description,
        })),
    }
  }
  return { completions: [] }
}

/** Completion must also work while the document is temporarily invalid. Parsing stays in the worker. */
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
        ? 'Signal'
        : row !== undefined && tree
          ? findNodeAtLocation(tree, [array, row, 'class'])?.value
          : 'Case'
  const shape = catalog.shapes.get(type)
  if (!shape) return []
  const group = path.slice(row === undefined ? 0 : 2, -1)
  const fields = [...shape.plan.values()]
    .filter((plan) => !plan.definition.sampled)
    .flatMap((plan) => {
      const paths =
        plan.source.kind === 'position'
          ? [
              ['extension', 'longitude'],
              ['extension', 'latitude'],
            ]
          : [nativePath(shape, plan)]
      return paths
        .filter((path) => JSON.stringify(path.slice(0, -1)) === JSON.stringify(group))
        .map((path) => ({
          name: path.at(-1)!,
          detail:
            (typeof plan.definition.type === 'string'
              ? plan.definition.type
              : plan.definition.type.kind) +
            (plan.definition.unit ? ' [' + plan.definition.unit + ']' : ''),
          description: plan.definition.description,
        }))
    })
  return [...new Map(fields.map((field) => [field.name, field])).values()]
}
