import { findNodeAtLocation } from 'jsonc-parser'
import type { Id } from 'latkit'

import { type Entity, entityKey } from '../shared/document.js'
import { problem } from '../shared/errors.js'
import type { Mutation, SourceEdit } from '../shared/messages.js'
import type { Case } from './case.js'
import type { ArrayName } from './definition.js'
import {
  apply,
  editable,
  fieldValue,
  nativePath,
  realText,
  textOffset,
  treeOf,
  withValue,
} from './edits.js'

/** The records `changes` add, as a transaction plans them: each identity proposed is resolved
 *  before any field, so a branch may name new buses, through the transaction's `resolve`, which
 *  knows what it removes and adds besides. A record goes after the last that stays, placed in the
 *  diagram where `positions` says. */
export function createRecords(
  kase: Case,
  changes: readonly Extract<Mutation, { kind: 'add' }>[],
  {
    resolve,
    removed,
    positions,
  }: {
    resolve(entity: Entity): Id | undefined
    removed: readonly Entity[]
    positions: ReadonlyMap<string, readonly [number, number] | null>
  },
): SourceEdit[] {
  const declared = new Map<string, Extract<Mutation, { kind: 'add' }>>()
  for (const change of changes) {
    const shape = kase.catalog.shapes.get(change.type)
    if (!shape?.array)
      throw problem('invalid-input', 'Choose a creatable type from inspect_case schema.')
    const valid =
      shape.identity.type === 'unsigned'
        ? typeof change.key === 'number' &&
          Number.isInteger(change.key) &&
          change.key >= 0 &&
          change.key <= 0xffffffff
        : typeof change.key === 'string' && change.key.length > 0
    if (!valid)
      throw problem('invalid-input', `Use a ${shape.identity.type} identity for ${change.type}.`)
    const entity = { table: change.type, id: change.key }
    const id = entityKey(entity)
    if (declared.has(id) || kase.locate(entity))
      throw problem('invalid-input', `Identity already exists: ${id}.`)
    declared.set(id, change)
  }
  const records = new Map<ArrayName, string[]>()
  for (const [id, change] of declared) {
    const shape = kase.catalog.shapes.get(change.type)!
    let text = JSON.stringify({
      ...(shape.kind === 'signal' ? {} : { class: change.type }),
      [shape.identity.name]: change.key,
    })
    for (const [field, value] of Object.entries(change.fields)) {
      const plan = shape.plan.get(field)
      if (!plan || !editable(plan))
        throw problem('invalid-input', `Unknown or non-writable field: ${change.type}.${field}.`)
      const native = fieldValue(plan, value, resolve)
      text = withValue(text, nativePath(plan), native)
      if (plan.decode === 'number' && typeof native === 'number') {
        const node = findNodeAtLocation(treeOf(text), nativePath(plan))!
        text = apply(text, [{ offset: node.offset, length: node.length, text: realText(native) }])
      }
    }
    for (const plan of shape.plan.values())
      if (
        plan.required &&
        plan.source.kind !== 'identity' &&
        (change.fields[plan.name] === undefined || change.fields[plan.name] === null)
      )
        throw problem('invalid-input', `${id} requires ${plan.name}.`)
    const position = positions.get(id)
    if (position) text = withValue(text, ['extension', 'diagram', 'position'], position)
    const list = records.get(shape.array!) ?? []
    list.push(text)
    records.set(shape.array!, list)
  }
  const edits: SourceEdit[] = []
  const missing: string[] = []
  const eol = kase.file.includes(13) ? '\r\n' : '\n'
  for (const [name, added] of records) {
    const array = kase.arrays[name]
    if (!array) {
      missing.push(JSON.stringify(name) + ': [' + added.join(',') + ']')
      continue
    }
    let last = array.ends.length - 1
    if (removed.length) {
      const removedRows = new Set<number>()
      for (const entity of removed) {
        const found = kase.locate(entity)
        if (found?.table.shape.array === name) removedRows.add(found.table.records[found.row]!)
      }
      while (removedRows.has(last)) last--
    }
    edits.push({
      offset: textOffset(kase, last < 0 ? array.open + 1 : array.ends[last]!),
      length: 0,
      text: (last < 0 ? '' : ',') + eol + '    ' + added.join(',' + eol + '    '),
    })
  }
  if (missing.length) {
    // A valid case can be an empty object; only nonempty objects need the leading comma.
    const hasMembers = kase.file
      .subarray(0, kase.close)
      .some((byte) => ![9, 10, 13, 32, 123].includes(byte))
    edits.push({
      offset: textOffset(kase, kase.close),
      length: 0,
      text: (hasMembers ? ',' : '') + missing.join(','),
    })
  }
  return edits.sort((a, b) => a.offset - b.offset)
}
