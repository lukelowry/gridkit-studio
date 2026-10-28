/** Validate a source transaction against its final graph, then edit retained source spans once. */
import type { Id } from 'latkit'

import { type Element, type Entity, entityKey, entityLabel } from '../shared/document.js'
import { problem } from '../shared/errors.js'
import type { Mutation, SourceEdit, Value } from '../shared/messages.js'
import type { Case } from './case.js'
import { createRecords } from './create.js'
import type { ArrayName } from './definition.js'
import { apply, editCase, editField, minimal, recordOf, textOffset, withValue } from './edits.js'
import { recordEdits } from './recording.js'

type Addition = Extract<Mutation, { kind: 'add' }>
export function planTransaction(kase: Case, mutations: readonly Mutation[]): SourceEdit[] {
  const records = mutations.filter((mutation) => mutation.kind === 'record')
  if (records.length) {
    if (
      records.length !== mutations.length ||
      new Set(records.map(({ type }) => type)).size !== records.length
    )
      throw problem('invalid-input', 'Change each type’s recording once, in a separate batch.')
    return recordEdits(kase, records)
  }
  const entities = new Map<string, Entity>()
  const keyOf = (entity: Entity) => {
    const key = entityKey(entity)
    entities.set(key, entity)
    return key
  }
  const added = new Map<string, Addition>()
  const removed = new Set<string>()
  const fields = new Map<string, Map<string, Value>>()
  const positions = new Map<string, readonly [number, number] | null>()
  const set = (entity: Entity, field: string, value: Value) => {
    const key = keyOf(entity)
    let values = fields.get(key)
    if (!values) fields.set(key, (values = new Map()))
    values.set(field, value)
  }
  for (const mutation of mutations) {
    if (mutation.kind === 'add') {
      const entity = { table: mutation.type, id: mutation.key }
      const key = keyOf(entity)
      if (added.has(key) || kase.locate(entity))
        throw problem('invalid-input', 'Identity already exists: ' + entityLabel(entity))
      added.set(key, { ...mutation, fields: { ...mutation.fields } })
    } else if (mutation.kind === 'remove') {
      if (!mutation.entities.length) throw problem('invalid-input', 'Choose components to remove.')
      for (const entity of mutation.entities) removed.add(keyOf(entity))
    }
  }
  const shapeOf = (entity: Entity) => {
    const key = keyOf(entity)
    const shape = added.has(key)
      ? kase.catalog.shapes.get(entity.table)
      : kase.locate(entity)?.table.shape
    if (!shape || removed.has(key))
      throw problem(
        'invalid-input',
        'Component is absent from the final case: ' + entityLabel(entity),
      )
    return shape
  }
  const resolve = (entity: Entity): Id | undefined => {
    const key = entityKey(entity)
    if (removed.has(key)) return undefined
    const addition = added.get(key)
    if (addition) return addition.key
    const found = kase.locate(entity)
    return found ? kase.native(found.table, found.row) : undefined
  }
  const valueOf = (entity: Entity, field: string): Value => {
    const key = entityKey(entity)
    if (fields.get(key)?.has(field)) return fields.get(key)!.get(field)!
    if (added.has(key)) return added.get(key)!.fields[field] ?? null
    const found = kase.locate(entity)!
    return kase.cell(found.table, field, found.row)
  }
  const portOf = (element: Element) => {
    const plan = element.field && shapeOf(element).ports.find((port) => port.name === element.field)
    if (!plan || !plan.definition.direction)
      throw problem('invalid-input', 'Connect a directed signal port.')
    const id = valueOf(element, plan.name)
    return {
      entity: element,
      plan,
      net:
        typeof id === 'string' || typeof id === 'number'
          ? { table: plan.definition.target, id }
          : null,
    }
  }
  for (const mutation of mutations) {
    if (mutation.kind === 'set') {
      shapeOf(mutation.entity)
      set(mutation.entity, mutation.field, mutation.value)
    } else if (mutation.kind === 'move') {
      shapeOf(mutation.entity)
      if (!kase.definition.drawing.blocks.some((block) => block.table === mutation.entity.table))
        throw problem('invalid-input', 'Only diagram blocks have diagram positions.')
      if (
        mutation.position !== null &&
        (mutation.position.length !== 2 || !mutation.position.every(Number.isFinite))
      )
        throw problem('invalid-input', 'Diagram positions must be finite [x, y] coordinates.')
      positions.set(keyOf(mutation.entity), mutation.position)
    } else if (mutation.kind === 'connect') {
      const from = portOf(mutation.from)
      if (!mutation.to) {
        if (from.plan.required)
          throw problem('invalid-input', 'This required port cannot be disconnected.')
        set(from.entity, from.plan.name, null)
        continue
      }
      const type = from.plan.definition.target
      let target: Entity | null
      let other: ReturnType<typeof portOf> | undefined
      if (mutation.to.field) {
        other = portOf(mutation.to)
        if (
          type !== other.plan.definition.target ||
          from.plan.definition.direction === other.plan.definition.direction
        )
          throw problem('invalid-input', 'Connect an output to an input of the same net type.')
        target =
          from.plan.definition.direction === 'out'
            ? (from.net ?? other.net)
            : (other.net ?? from.net)
      } else {
        if (shapeOf(mutation.to).type !== type)
          throw problem('invalid-input', 'Choose a compatible signal net.')
        target = mutation.to
      }
      if (!target) {
        const signals = kase.table(type)
        if (signals.shape.kind !== 'signal')
          throw problem('invalid-input', 'Only signal nets can be created by wiring.')
        let id = 0
        for (let row = 0; row < signals.records.length; row++)
          id = Math.max(id, Number(kase.native(signals, row)) + 1)
        for (const addition of added.values())
          if (addition.type === type) id = Math.max(id, Number(addition.key) + 1)
        if (id > 0xffffffff) throw problem('limit', 'No signal identity is available.')
        target = { table: type, id }
        added.set(keyOf(target), { kind: 'add', type, key: id, fields: { name: 'Signal ' + id } })
      }
      set(from.entity, from.plan.name, target.id)
      if (other) set(other.entity, other.plan.name, target.id)
    }
  }
  for (const key of removed) {
    const entity = entities.get(key)!
    if (added.has(key))
      throw problem('invalid-input', 'Do not add and remove the same identity in one batch.')
    if (!kase.locate(entity)?.table.shape.array)
      throw problem('invalid-input', 'This component cannot be removed: ' + entityLabel(entity))
  }
  const touchedNets = new Set<string>()
  const changed = new Set([...fields.keys(), ...added.keys()])
  for (const key of changed) {
    const entity = entities.get(key)!
    for (const port of shapeOf(entity).ports) {
      if (port.definition.direction !== 'out') continue
      if (!added.has(key) && !fields.get(key)?.has(port.name)) continue
      const id = valueOf(entity, port.name)
      if (typeof id === 'number' || typeof id === 'string')
        touchedNets.add(entityKey({ table: port.definition.target, id }))
    }
  }
  if (removed.size || touchedNets.size) {
    const occupied = new Map<string, string>()
    const check = (entity: Entity) => {
      for (const port of shapeOf(entity).ports) {
        const id = valueOf(entity, port.name)
        if (typeof id !== 'string' && typeof id !== 'number') continue
        const target = { table: port.definition.target, id }
        const key = entityKey(target)
        if (removed.has(key))
          throw problem(
            'invalid-input',
            entityLabel(entity) +
              '.' +
              port.name +
              ' still references removed ' +
              entityLabel(target) +
              '.',
          )
        if (port.definition.direction !== 'out' || !touchedNets.has(key)) continue
        const name = entityLabel(entity) + '.' + port.name
        const previous = occupied.get(key)
        if (previous)
          throw problem(
            'invalid-input',
            'This signal already has an output driver: ' +
              entityLabel(target) +
              ' (' +
              previous +
              ', ' +
              name +
              ').',
          )
        occupied.set(key, name)
      }
    }
    for (const table of kase.tables.values()) {
      if (!table.shape.ports.length) continue
      for (let row = 0; row < table.records.length; row++) {
        const entity = kase.entity(table, row)
        if (!removed.has(entityKey(entity))) check(entity)
      }
    }
    for (const key of added.keys()) check(entities.get(key)!)
  }
  const edits: SourceEdit[] = []
  for (const key of new Set([...fields.keys(), ...positions.keys()])) {
    const entity = entities.get(key)!
    const addition = added.get(key)
    if (addition) {
      Object.assign(addition.fields, Object.fromEntries(fields.get(key) ?? []))
      continue
    }
    if (kase.locate(entity)?.table.shape.array === null) {
      edits.push(...editCase(kase, fields.get(key) ?? new Map(), resolve))
      continue
    }
    const record = recordOf(kase, entity)
    let after = record.text
    for (const [field, value] of fields.get(key) ?? [])
      after = apply(after, editField(kase, entity, field, value, after, resolve))
    if (positions.has(key))
      after = withValue(
        after,
        ['extension', 'diagram', 'position'],
        positions.get(key) ?? undefined,
      )
    const change = minimal(record.text, after, record.offset)
    if (change.length || change.text) edits.push(change)
  }
  const byArray = new Map<ArrayName, Set<number>>()
  for (const key of removed) {
    const found = kase.locate(entities.get(key)!)!
    const name = found.table.shape.array!
    let indices = byArray.get(name)
    if (!indices) byArray.set(name, (indices = new Set()))
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
      const end =
        first === 0 && last < array.starts.length - 1 ? array.starts[last + 1]! : array.ends[last]!
      const offset = textOffset(kase, start)
      edits.push({ offset, length: textOffset(kase, end) - offset, text: '' })
    }
  }
  if (added.size)
    edits.push(
      ...createRecords(kase, [...added.values()], {
        resolve,
        removed: [...removed].map((key) => entities.get(key)!),
        positions,
      }),
    )
  edits.sort((a, b) => a.offset - b.offset || b.length - a.length)
  const combined: SourceEdit[] = []
  for (const edit of edits) {
    const previous = combined.at(-1)
    if (previous?.offset === edit.offset && edit.length === 0) previous.text += edit.text
    else if (previous && edit.offset < previous.offset + previous.length)
      throw problem('invalid-input', 'Conflicting changes touch the same source record.')
    else combined.push(edit)
  }
  return combined
}
