import type { Layout } from '@latkit/gpu'
import { failure, type FieldInput } from '@latkit/model'
import { findNodeAtLocation } from 'jsonc-parser'

import type { Mutation, SourceEdit } from '../shared/messages.js'
import { diagramOf } from '../shared/schema.js'
import type { Case } from './case.js'
import { apply, recordAt, treeOf } from './edits.js'
import { planTransaction } from './plan.js'
import { Turns } from './turns.js'

/** The source edits that make `mutations`, by row ID; only the records they touch are read. */
export function transaction(kase: Case, mutations: readonly Mutation[]): SourceEdit[] {
  if (!Array.isArray(mutations) || !mutations.length)
    throw failure('invalid-input', 'A transaction needs a change.')
  return planTransaction(kase, mutations)
}
const presentations = new WeakMap<Case, Record<string, Layout.Positions>>()
/** What a record that places a diagram block writes. */
const DIAGRAM = Buffer.from('"diagram"')

/** Each diagram block's position, from `extension.diagram.position` in its own record. Only the
 *  records that write `"diagram"` are read, found by one search of the file's bytes. */
export async function presentation(
  kase: Case,
  signal: AbortSignal,
): Promise<Record<string, Layout.Positions>> {
  const cached = presentations.get(kase)
  if (cached) return cached
  const work = new Turns(signal)
  const result: Record<string, Layout.Positions> = {}
  const file = Buffer.from(kase.file.buffer, kase.file.byteOffset, kase.file.byteLength)
  const found: number[] = []
  for (let at = file.indexOf(DIAGRAM); at >= 0; at = file.indexOf(DIAGRAM, at + 1)) found.push(at)
  for (const type of diagramOf(kase.schema).vertices) {
    const table = kase.tables.get(type)
    const array = table?.shape.array ? kase.arrays[table.shape.array] : undefined
    if (!table || !array) continue
    const rows: number[] = []
    const xs: number[] = []
    const ys: number[] = []
    let next = 0
    for (let row = 0; row < table.records.length; row++) {
      const record = table.records[row]!
      // A table's records are in file order, as is what was found.
      while (next < found.length && found[next]! < array.starts[record]!) next++
      if (!(next < found.length && found[next]! < array.ends[record]!)) continue
      await work.step()
      const { text } = recordAt(kase, table, row)
      const position = findNodeAtLocation(treeOf(text), ['extension', 'diagram', 'position'])
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
