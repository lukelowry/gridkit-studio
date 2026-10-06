import { failure, type Value } from '@latkit/model'

import type { Mutation, SourceEdit } from '../shared/messages.js'
import { diagramOf, elementType } from '../shared/schema.js'
import type { Case } from './case.js'
import { createRecords } from './create.js'
import type { ArrayName } from './definition.js'
import { apply, editField, minimal, recordOf, textOffset, withValue } from './edits.js'

type Addition = Extract<Mutation, { kind: 'add' }>
/** Validate the final graph, then emit disjoint edits against the original source once. */
export function planTransaction(kase: Case, mutations: readonly Mutation[]): SourceEdit[] {
  const added = new Map<string, Addition>()
  const removed = new Set<string>()
  const fields = new Map<string, Map<string, Value>>()
  const positions = new Map<string, readonly [number, number] | null>()
  const set = (id: string, field: string, value: Value) => {
    let values = fields.get(id)
    if (!values) fields.set(id, values = new Map())
    values.set(field, value)
  }
  for (const mutation of mutations) {
    if (mutation.kind === 'add') {
      const id = mutation.type + '/' + mutation.key
      if (added.has(id) || kase.locate(id)) throw failure('invalid-input', 'Identity already exists: ' + id)
      added.set(id, { ...mutation, fields: { ...mutation.fields } })
    } else if (mutation.kind === 'remove') {
      if (!mutation.ids.length) throw failure('invalid-input', 'Choose components to remove.')
      for (const id of mutation.ids) removed.add(id)
    }
  }
  const shapeOf = (id: string) => {
    const shape = added.has(id) ? kase.catalog.shapes.get(added.get(id)!.type) : kase.locate(id)?.table.shape
    if (!shape || removed.has(id)) throw failure('invalid-input', 'Component is absent from the final case: ' + id)
    return shape
  }
  const resolve = (id: string, type: string) => {
    if (removed.has(id)) return undefined
    const addition = added.get(id)
    if (addition) return addition.type === type ? addition.key : undefined
    const found = kase.locate(id)
    return found?.table.shape.type === type ? kase.native(found.table, found.row) : undefined
  }
  const valueOf = (id: string, field: string): Value => {
    if (fields.get(id)?.has(field)) return fields.get(id)!.get(field)!
    if (added.has(id)) return added.get(id)!.fields[field] ?? null
    const found = kase.locate(id)!
    const value = kase.cell(found.table, field, found.row)
    const type = found.table.shape.plan.get(field)!.definition.type
    return typeof type === 'object' && type.kind === 'reference' && typeof value === 'number'
      ? kase.id(kase.table(type.to), value) : value
  }
  const portOf = (item: { id: string; field?: string }) => {
    const plan = item.field && shapeOf(item.id).ports.find(port => port.name === item.field)
    if (!plan || !plan.definition.direction) throw failure('invalid-input', 'Connect a directed signal port.')
    return { id: item.id, plan, net: valueOf(item.id, plan.name) as string | null }
  }
  for (const mutation of mutations) {
    if (mutation.kind === 'set') {
      shapeOf(mutation.id)
      set(mutation.id, mutation.field, mutation.value)
    } else if (mutation.kind === 'move') {
      shapeOf(mutation.id)
      if (!diagramOf(kase.schema).vertices.includes(elementType(mutation.id))) throw failure('invalid-input', 'Only diagram blocks have diagram positions.')
      if (mutation.position !== null && (mutation.position.length !== 2 || !mutation.position.every(Number.isFinite))) throw failure('invalid-input', 'Diagram positions must be finite [x, y] coordinates.')
      positions.set(mutation.id, mutation.position)
    } else if (mutation.kind === 'connect') {
      const from = portOf(mutation.from)
      if (!mutation.to) {
        if (from.plan.required) throw failure('invalid-input', 'This required port cannot be disconnected.')
        set(from.id, from.plan.name, null)
        continue
      }
      const type = from.plan.definition.type.to
      let target: string | null
      let other: ReturnType<typeof portOf> | undefined
      if (mutation.to.field) {
        other = portOf(mutation.to)
        if (type !== other.plan.definition.type.to || from.plan.definition.direction === other.plan.definition.direction) throw failure('invalid-input', 'Connect an output to an input of the same net type.')
        target = from.plan.definition.direction === 'out' ? from.net ?? other.net : other.net ?? from.net
      } else {
        if (shapeOf(mutation.to.id).type !== type) throw failure('invalid-input', 'Choose a compatible signal net.')
        target = mutation.to.id
      }
      if (target === null) {
        const signals = kase.table(type)
        if (signals.shape.kind !== 'signal') throw failure('invalid-input', 'Only signal nets can be created by wiring.')
        let key = 0
        for (let row = 0; row < signals.records.length; row++) key = Math.max(key, Number(kase.native(signals, row)) + 1)
        for (const addition of added.values()) if (addition.type === type) key = Math.max(key, Number(addition.key) + 1)
        if (key > 0xffffffff) throw failure('resource-limit', 'No signal identity is available.')
        target = type + '/' + key
        added.set(target, { kind: 'add', type, key, fields: { name: 'Signal ' + key } })
      }
      set(from.id, from.plan.name, target)
      if (other) set(other.id, other.plan.name, target)
    }
  }
  for (const id of removed) {
    if (added.has(id)) throw failure('invalid-input', 'Do not add and remove the same identity in one batch: ' + id)
    if (!kase.locate(id)?.table.shape.array) throw failure('invalid-input', 'This component cannot be removed: ' + id)
  }
  // Evaluate only final port values. Unrelated pre-existing invalid references are left repairable.
  const occupied = new Map<string, string>()
  const touchedNets = new Set<string>()
  for (const [id, values] of fields) for (const [field, value] of values) {
    if (shapeOf(id).plan.get(field)?.definition.direction === 'out' && typeof value === 'string') touchedNets.add(value)
  }
  for (const addition of added.values()) for (const port of kase.catalog.shapes.get(addition.type)?.ports ?? []) {
    const target = fields.get(addition.type + '/' + addition.key)?.get(port.name) ?? addition.fields[port.name]
    if (port.definition.direction === 'out' && typeof target === 'string') touchedNets.add(target)
  }
  const check = (id: string) => {
    for (const port of shapeOf(id).ports) {
      const target = valueOf(id, port.name)
      if (typeof target !== 'string') continue
      if (removed.has(target)) throw failure('invalid-input', `${id}.${port.name} still references removed ${target}.`)
      if (port.definition.direction !== 'out' || !touchedNets.has(target)) continue
      const previous = occupied.get(target)
      if (previous) throw failure('invalid-input', `This signal already has an output driver: ${target} (${previous}, ${id}.${port.name}).`)
      occupied.set(target, id + '.' + port.name)
    }
  }
  for (const table of kase.tables.values()) for (let row = 0; row < table.records.length; row++) {
    const id = kase.id(table, row)
    if (!removed.has(id)) check(id)
  }
  for (const id of added.keys()) check(id)
  const edits: SourceEdit[] = []
  for (const id of new Set([...fields.keys(), ...positions.keys()])) {
    const addition = added.get(id)
    if (addition) {
      Object.assign(addition.fields, Object.fromEntries(fields.get(id) ?? []))
      continue
    }
    const record = recordOf(kase, id)
    let after = record.text
    for (const [field, value] of fields.get(id) ?? []) after = apply(after, editField(kase, id, field, value, after, resolve))
    if (positions.has(id)) after = withValue(after, ['extension', 'diagram', 'position'], positions.get(id) ?? undefined)
    const change = minimal(record.text, after, record.offset)
    if (change.length || change.text) edits.push(change)
  }
  const byArray = new Map<ArrayName, Set<number>>()
  for (const id of removed) {
    const found = kase.locate(id)!
    const name = found.table.shape.array!
    let indices = byArray.get(name)
    if (!indices) byArray.set(name, indices = new Set())
    indices.add(found.table.records[found.row]!)
  }
  for (const [name, indices] of byArray) {
    const array = kase.arrays[name]!
    const rows = [...indices].sort((a, b) => a - b)
    for (let n = 0; n < rows.length; n++) {
      const first = rows[n]!
      let last = first
      while (rows[n + 1] === last + 1) last = rows[++n]!
      const start = first > 0 ? array.ends[first - 1]! : array.starts[first]!
      const end = first === 0 && last < array.starts.length - 1 ? array.starts[last + 1]! : array.ends[last]!
      const offset = textOffset(kase, start)
      edits.push({ offset, length: textOffset(kase, end) - offset, text: '' })
    }
  }
  if (added.size) edits.push(...createRecords(kase, [...added.values()], { resolve, removed, positions }))
  edits.sort((a, b) => a.offset - b.offset || b.length - a.length)
  const combined: SourceEdit[] = []
  for (const edit of edits) {
    const previous = combined.at(-1)
    if (previous?.offset === edit.offset && edit.length === 0) previous.text += edit.text
    else if (previous && edit.offset < previous.offset + previous.length) throw failure('invalid-input', 'Conflicting changes touch the same source record.')
    else combined.push(edit)
  }
  return combined
}
