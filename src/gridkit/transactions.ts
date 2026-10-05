import type { Positions } from '@latkit/diagram'
import { failure, type FieldValues } from '@latkit/model'
import { findNodeAtLocation, modify, parseTree } from 'jsonc-parser'

import type { Mutation, SourceEdit } from '../shared/messages.js'
import { diagramOf } from '../shared/schema.js'
import type { Case } from './case.js'
import { editField, nativePath, recordOf, textOffset } from './edits.js'

const decoder = new TextDecoder()
export const MAX_MUTATIONS = 10000
function apply(text: string, edits: readonly SourceEdit[]) {
  for (const edit of [...edits].sort((a, b) => b.offset - a.offset))
    text = text.slice(0, edit.offset) + edit.text + text.slice(edit.offset + edit.length)
  return text
}
function minimal(before: string, after: string, offset: number): SourceEdit | undefined {
  let start = 0
  let end = before.length
  let stop = after.length
  while (start < end && start < stop && before[start] === after[start]) start++
  while (end > start && stop > start && before[end - 1] === after[stop - 1]) {
    end--
    stop--
  }
  return start === end && start === stop
    ? undefined
    : { offset: offset + start, length: end - start, text: after.slice(start, stop) }
}
/** Worker-side transactions are addressed by stable domain IDs. Only touched records are materialized. */
export function transaction(kase: Case, mutations: readonly Mutation[]): SourceEdit[] {
  if (!Array.isArray(mutations) || !mutations.length || mutations.length > MAX_MUTATIONS)
    throw failure('resource-limit', 'A transaction must contain 1–10,000 changes.')
  const records = new Map<string, { offset: number; before: string; after: string }>()
  const extra: SourceEdit[] = []
  const get = (id: string) => {
    let record = records.get(id)
    if (!record) {
      const located = recordOf(kase, id)
      records.set(
        id,
        (record = { offset: located.offset, before: located.text, after: located.text }),
      )
    }
    return record
  }
  const path = (id: string, keys: string[], value: unknown) => {
    const record = get(id)
    const tree = parseTree(record.after)!
    const node = findNodeAtLocation(tree, keys)
    if (node && value !== undefined) {
      record.after = apply(record.after, [
        { offset: node.offset, length: node.length, text: JSON.stringify(value) },
      ])
    } else {
      record.after = apply(
        record.after,
        modify(record.after, keys, value, {}).map((edit) => ({
          offset: edit.offset,
          length: edit.length,
          text: edit.content,
        })),
      )
    }
  }
  let connection = false
  for (const mutation of mutations) {
    if (mutation.kind === 'set') {
      const record = get(mutation.id)
      record.after = apply(
        record.after,
        editField(kase, mutation.id, mutation.field, mutation.value, record.after),
      )
    } else if (mutation.kind === 'move') {
      if (!diagramOf(kase.schema).vertices.includes(mutation.id.split('/')[0]!))
        throw failure('invalid-input', 'Only diagram blocks have diagram positions.')
      if (
        mutation.position !== null &&
        (!Array.isArray(mutation.position) ||
          mutation.position.length !== 2 ||
          !mutation.position.every(Number.isFinite))
      )
        throw failure('invalid-input', 'Diagram positions must be finite [x, y] coordinates.')
      path(mutation.id, ['extension', 'diagram', 'position'], mutation.position ?? undefined)
    } else if (mutation.kind === 'remove') {
      if (mutations.length !== 1 || !mutation.ids.length || mutation.ids.length > MAX_MUTATIONS)
        throw failure('invalid-input', 'Delete elements as one transaction.')
      const ids = new Set<string>(mutation.ids)
      for (const table of kase.tables.values())
        for (const plan of table.shape.ports)
          for (let row = 0; row < table.records.length; row++) {
            if (ids.has(kase.id(table, row))) continue
            const reference = kase.cell(table, plan.name, row)
            if (
              typeof reference === 'number' &&
              ids.has(kase.id(kase.table(plan.definition.type.to), reference))
            )
              throw failure(
                'invalid-input',
                kase.id(table, row) +
                  '.' +
                  plan.name +
                  ' still references this element. Disconnect it first.',
              )
          }
      const byArray = new Map<string, Set<number>>()
      for (const id of ids) {
        const located = kase.locate(id)
        if (!located || !located.table.shape.array)
          throw failure('invalid-input', 'This element cannot be deleted.')
        const array = located.table.shape.array
        let rows = byArray.get(array)
        if (!rows) byArray.set(array, (rows = new Set()))
        rows.add(located.table.records[located.row]!)
      }
      for (const [name, set] of byArray) {
        const array = kase.arrays[name as 'buses' | 'signals' | 'devices']!
        const rows = [...set].sort((a, b) => a - b)
        for (let n = 0; n < rows.length; n++) {
          const first = rows[n]!
          let last = first
          while (rows[n + 1] === last + 1) last = rows[++n]!
          const start = first > 0 ? array.ends[first - 1]! : array.starts[first]!
          const end =
            first === 0 && last < array.starts.length - 1
              ? array.starts[last + 1]!
              : array.ends[last]!
          const offset = textOffset(kase, start)
          extra.push({ offset, length: textOffset(kase, end) - offset, text: '' })
        }
      }
    } else if (mutation.kind === 'connect') {
      if (connection || mutations.length !== 1)
        throw failure('invalid-input', 'A connection is one atomic transaction.')
      connection = true
      const port = (item: { id: string; field?: string }) => {
        const located = kase.locate(item.id)
        const plan =
          located && item.field
            ? located.table.shape.ports.find((plan) => plan.name === item.field)
            : undefined
        if (!located || !plan || !plan.definition.direction)
          throw failure('invalid-input', 'Connect a directed signal port.')
        const row = kase.cell(located.table, plan.name, located.row)
        return {
          ...located,
          plan,
          id: item.id,
          net: typeof row === 'number' ? kase.id(kase.table(plan.definition.type.to), row) : null,
        }
      }
      const from = port(mutation.from)
      const changes: { id: string; field: string; value: string | null }[] = []
      if (mutation.to === null) {
        if (from.plan.required)
          throw failure('invalid-input', 'This required port cannot be disconnected.')
        changes.push({ id: from.id, field: from.plan.name, value: null })
      } else {
        let target: string | null = null
        let other: ReturnType<typeof port> | undefined
        if (mutation.to.field) {
          other = port(mutation.to)
          if (
            other.plan.definition.type.to !== from.plan.definition.type.to ||
            other.plan.definition.direction === from.plan.definition.direction
          )
            throw failure('invalid-input', 'Connect an output to an input of the same net type.')
          const output = from.plan.definition.direction === 'out' ? from : other
          const input = from.plan.definition.direction === 'in' ? from : other
          target = output.net ?? input.net
          if (output.net && input.net && output.net !== input.net) target = output.net
        } else {
          const net = kase.locate(mutation.to.id)
          if (!net || net.table.shape.type !== from.plan.definition.type.to)
            throw failure('invalid-input', 'Choose a compatible signal net.')
          target = mutation.to.id
        }
        if (target === null) {
          const signals = kase.table(from.plan.definition.type.to)
          if (signals.shape.kind !== 'signal')
            throw failure('invalid-input', 'Only signal nets can be created by wiring.')
          let number = 0
          for (let row = 0; row < signals.records.length; row++)
            number = Math.max(number, Number(kase.native(signals, row)) + 1)
          if (number > 0xffffffff) throw failure('resource-limit', 'No signal ID is available.')
          target = signals.shape.type + '/' + number
          const array = kase.arrays.signals
          const last = (array?.starts.length ?? 0) - 1
          const at =
            array === undefined ? kase.close : last < 0 ? array.open + 1 : array.ends[last]!
          const text = JSON.stringify({ signal_id: number, name: 'Signal ' + number })
          const eol = kase.file.includes(13) ? '\r\n' : '\n'
          extra.push({
            offset: textOffset(kase, at),
            length: 0,
            text:
              array === undefined
                ? ', "signals": [' + text + ']'
                : last < 0
                  ? text
                  : ',' + eol + '    ' + text,
          })
        }
        changes.push({ id: from.id, field: from.plan.name, value: target })
        if (other) changes.push({ id: other.id, field: other.plan.name, value: target })
        // Reject a second output driver before changing any source text.
        const driver = changes.find((change) => {
          const found = kase.locate(change.id)!
          return found.table.shape.plan.get(change.field)!.definition.direction === 'out'
        })
        if (driver)
          for (const table of kase.tables.values())
            for (const definition of table.shape.ports) {
              if (
                definition.definition.direction !== 'out' ||
                definition.definition.type.to !== from.plan.definition.type.to
              )
                continue
              for (let row = 0; row < table.records.length; row++) {
                const id = kase.id(table, row)
                if (changes.some((change) => change.id === id && change.field === definition.name))
                  continue
                const net = kase.cell(table, definition.name, row)
                if (
                  typeof net === 'number' &&
                  kase.id(kase.table(from.plan.definition.type.to), net) === target
                )
                  throw failure('invalid-input', 'This signal already has an output driver.')
              }
            }
      }
      for (const change of changes) {
        const located = kase.locate(change.id)!
        const plan = located.table.shape.plan.get(change.field)!
        const native =
          change.value === null ? null : Number(change.value.slice(change.value.indexOf('/') + 1))
        path(change.id, nativePath(located.table.shape, plan), native)
      }
    } else throw failure('invalid-input', 'Unknown document mutation.')
  }

  // Field edits and wire gestures share the same single-driver invariant.
  const touchedOutputs = new Map<string, string | null>()
  for (const mutation of mutations) {
    if (mutation.kind !== 'set') continue
    const located = kase.locate(mutation.id)
    const plan = located?.table.shape.plan.get(mutation.field)
    if (plan?.definition.direction === 'out')
      touchedOutputs.set(mutation.id + '\0' + mutation.field, mutation.value as string | null)
  }
  if (touchedOutputs.size) {
    const targets = new Set(
      [...touchedOutputs.values()].filter((value): value is string => value !== null),
    )
    const occupied = new Set<string>()
    for (const table of kase.tables.values())
      for (const plan of table.shape.ports) {
        if (plan.definition.direction !== 'out') continue
        for (let row = 0; row < table.records.length; row++) {
          const key = kase.id(table, row) + '\0' + plan.name
          const current = kase.cell(table, plan.name, row)
          const target = touchedOutputs.has(key)
            ? touchedOutputs.get(key)
            : typeof current === 'number'
              ? kase.id(kase.table(plan.definition.type.to), current)
              : null
          if (!target || !targets.has(target)) continue
          if (occupied.has(target))
            throw failure('invalid-input', 'This signal already has an output driver.')
          occupied.add(target)
        }
      }
  }
  const edits = [...records.values()]
    .flatMap((record) => {
      const edit = minimal(record.before, record.after, record.offset)
      return edit ? [edit] : []
    })
    .concat(extra)
    .sort((a, b) => a.offset - b.offset)
  for (let index = 1; index < edits.length; index++)
    if (edits[index]!.offset < edits[index - 1]!.offset + edits[index - 1]!.length)
      throw failure('invalid-input', 'Overlapping record changes must be submitted separately.')
  if (edits.reduce((bytes, edit) => bytes + edit.text.length, 0) > 4 << 20)
    throw failure('resource-limit', 'A transaction may insert at most 4 MiB of text.')
  return edits
}
const presentations = new WeakMap<Case, Record<string, Positions>>()
/** Presentation metadata is separate from the domain Schema, stored with each native record for Git. */
export function presentation(kase: Case): Record<string, Positions> {
  const cached = presentations.get(kase)
  if (cached) return cached
  const result: Record<string, Positions> = {}
  if (!decoder.decode(kase.file).includes('"diagram"')) {
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
      const record = recordOf(kase, kase.id(table, row))
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
      const axis = (values: number[]): FieldValues => ({
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
export function applyChanges(text: string, changes: readonly (readonly SourceEdit[])[]): string {
  for (const group of changes) text = apply(text, group)
  return text
}
