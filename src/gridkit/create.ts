import { failure } from '@latkit/model'
import { findNodeAtLocation, parseTree } from 'jsonc-parser'

import type { Mutation, SourceEdit } from '../shared/messages.js'
import type { Case } from './case.js'
import type { ArrayName } from './definition.js'
import { apply, editable, fieldValue, nativePath, textOffset, withValue } from './edits.js'
import { realText } from './staging.js'

/** Resolve the entire proposed identity set before fields, so a branch may name new buses. */
export function createRecords(
  kase: Case,
  changes: readonly Extract<Mutation, { kind: 'add' }>[],
  options?: {
    resolve(id: string, type: string): string | number | undefined
    removed: ReadonlySet<string>
    positions: ReadonlyMap<string, readonly [number, number] | null>
  },
): SourceEdit[] {
  const declared = new Map<string, Extract<Mutation, { kind: 'add' }>>()
  for (const change of changes) {
    const shape = kase.catalog.shapes.get(change.type)
    if (!shape?.array)
      throw failure('invalid-input', 'Choose a creatable type from inspect_case schema.')
    const valid =
      shape.identity.type === 'uint32'
        ? typeof change.key === 'number' &&
          Number.isInteger(change.key) &&
          change.key >= 0 &&
          change.key <= 0xffffffff
        : typeof change.key === 'string' && change.key.length > 0
    if (!valid)
      throw failure('invalid-input', `Use a ${shape.identity.type} identity for ${change.type}.`)
    const id = change.type + '/' + change.key
    if (declared.has(id) || kase.locate(id))
      throw failure('invalid-input', `Identity already exists: ${id}.`)
    declared.set(id, change)
  }
  const occupied = new Set<string>()
  for (const table of options ? [] : kase.tables.values())
    for (const port of table.shape.ports) {
      if (port.definition.direction !== 'out') continue
      for (let row = 0; row < table.records.length; row++) {
        const target = kase.cell(table, port.name, row)
        if (typeof target === 'number')
          occupied.add(kase.id(kase.table(port.definition.type.to), target))
      }
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
        throw failure('invalid-input', `Unknown or non-writable field: ${change.type}.${field}.`)
      const native = fieldValue(
        plan,
        value,
        options?.resolve ??
          ((targetId, type) => {
            const added = declared.get(targetId)
            if (added?.type === type) return added.key
            const target = kase.locate(targetId)
            return target?.table.shape.type === type
              ? kase.native(target.table, target.row)
              : undefined
          }),
      )
      if (!options && plan.definition.direction === 'out' && value !== null) {
        if (occupied.has(String(value)))
          throw failure('invalid-input', `This signal already has an output driver: ${value}.`)
        occupied.add(String(value))
      }
      text = withValue(text, nativePath(plan), native)
      if (plan.definition.type === 'float64' && typeof native === 'number') {
        const node = findNodeAtLocation(parseTree(text)!, nativePath(plan))!
        text = apply(text, [{ offset: node.offset, length: node.length, text: realText(native) }])
      }
    }
    for (const plan of shape.plan.values())
      if (
        plan.required &&
        plan.source.kind !== 'identity' &&
        (change.fields[plan.name] === undefined || change.fields[plan.name] === null)
      )
        throw failure('invalid-input', `${id} requires ${plan.name}.`)
    const position = options?.positions.get(id)
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
    if (options?.removed.size) {
      const removedRows = new Set<number>()
      for (const id of options.removed) {
        const found = kase.locate(id)
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
