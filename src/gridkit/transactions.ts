import type { Layout } from '@latkit/gpu'
import { failure, type FieldInput } from '@latkit/model'
import { findNodeAtLocation, parseTree } from 'jsonc-parser'

import type { Mutation, SourceEdit } from '../shared/messages.js'
import { diagramOf } from '../shared/schema.js'
import type { Case } from './case.js'
import { apply, recordAt } from './edits.js'
import { planTransaction } from './plan.js'

/** The source edits that make `mutations`, by row ID; only the records they touch are read. */
export function transaction(kase: Case, mutations: readonly Mutation[]): SourceEdit[] {
  if (!Array.isArray(mutations) || !mutations.length)
    throw failure('invalid-input', 'A transaction needs a change.')
  return planTransaction(kase, mutations)
}
const presentations = new WeakMap<Case, Record<string, Layout.Positions>>()

/** Each diagram block's position, from `extension.diagram.position` in its own record. */
export function presentation(kase: Case): Record<string, Layout.Positions> {
  const cached = presentations.get(kase)
  if (cached) return cached
  const result: Record<string, Layout.Positions> = {}
  // A case that places no block says nothing of a diagram; its bytes are searched where they lie.
  const file = Buffer.from(kase.file.buffer, kase.file.byteOffset, kase.file.byteLength)
  if (!file.includes('"diagram"')) {
    presentations.set(kase, result)
    return result
  }
  for (const type of diagramOf(kase.schema).vertices) {
    const table = kase.tables.get(type)
    if (!table?.records.length) continue
    const rows: number[] = []
    const xs: number[] = []
    const ys: number[] = []
    for (let row = 0; row < table.records.length; row++) {
      const record = recordAt(kase, table, row)
      const position = findNodeAtLocation(parseTree(record.text)!, [
        'extension',
        'diagram',
        'position',
      ])
      if (
        position?.type === 'array' &&
        position.children?.length === 2 &&
        position.children.every((node) => node.type === 'number' && Number.isFinite(node.value))
      ) {
        rows.push(row)
        xs.push(position.children[0]!.value)
        ys.push(position.children[1]!.value)
      }
    }
    if (rows.length) {
      const placed = { kind: 'indices', values: Uint32Array.from(rows) } as const
      const axis = (values: number[]): FieldInput.Values => ({
        index: table.index,
        rows: placed,
        values: {
          kind: 'numeric',
          offset: 0,
          length: values.length,
          values: Float64Array.from(values),
        },
      })
      result[type] = { x: axis(xs), y: axis(ys) }
    }
  }
  presentations.set(kase, result)
  return result
}

/** `text` with each group of edits applied in turn, every group against the text before it. */
export function applyChanges(text: string, changes: readonly (readonly SourceEdit[])[]): string {
  for (const group of changes) text = apply(text, group)
  return text
}
