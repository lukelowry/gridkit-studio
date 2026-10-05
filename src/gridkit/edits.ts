import { failure, type Value } from '@latkit/model'
import { findNodeAtLocation, type JSONPath, modify, parseTree } from 'jsonc-parser'

import { message } from '../shared/format.js'
import type { Issue, SourceEdit, SourceRange } from '../shared/messages.js'
import type { Case } from './case.js'
import type { FieldPlan } from './definition.js'
import { realText } from './staging.js'

const decoder = new TextDecoder()
const checkpoints = new WeakMap<Case, { bytes: number[]; chars: number[] }>()

/** The UTF-16 offset of `byte` in the case's file, as VS Code counts. Checkpoints every 4 KiB fall on
 *  code-point boundaries, so only the bytes past one are decoded. */
export function textOffset(kase: Case, byte: number): number {
  let map = checkpoints.get(kase)
  if (!map) {
    map = { bytes: [0], chars: [0] }
    let chars = 0
    let next = 4096
    for (let at = 0; at < kase.file.length;) {
      const first = kase.file[at]!
      const width = first < 128 ? 1 : first < 224 ? 2 : first < 240 ? 3 : 4
      at += width
      chars += width === 4 ? 2 : 1
      if (at >= next) {
        map.bytes.push(at)
        map.chars.push(chars)
        next = at + 4096
      }
    }
    checkpoints.set(kase, map)
  }
  let low = 0
  let high = map.bytes.length
  while (low + 1 < high) {
    const mid = (low + high) >>> 1
    if (map.bytes[mid]! <= byte) low = mid
    else high = mid
  }
  return map.chars[low]! + decoder.decode(kase.file.subarray(map.bytes[low]!, byte)).length
}

/** `text` with `edits` applied; each edit's offset is into `text` as given. */
export function apply(text: string, edits: readonly SourceEdit[]): string {
  for (const edit of [...edits].sort((a, b) => b.offset - a.offset))
    text = text.slice(0, edit.offset) + edit.text + text.slice(edit.offset + edit.length)
  return text
}

/** `text` with `value` set at `path` by jsonc-parser, which leaves the rest unformatted. */
export function withValue(text: string, path: JSONPath, value: unknown): string {
  return apply(
    text,
    modify(text, path, value, {}).map((edit) => ({
      offset: edit.offset,
      length: edit.length,
      text: edit.content,
    })),
  )
}

/** The one edit that turns `before`, at `offset`, into `after`: the span where they differ. */
export function minimal(before: string, after: string, offset: number): SourceEdit {
  let start = 0
  let end = before.length
  let stop = after.length
  while (start < end && start < stop && before[start] === after[start]) start++
  while (end > start && stop > start && before[end - 1] === after[stop - 1]) {
    end--
    stop--
  }
  return { offset: offset + start, length: end - start, text: after.slice(start, stop) }
}

/** Where a field's value is in its record's JSON. */
export function nativePath(field: FieldPlan): string[] {
  const source = field.source
  switch (source.kind) {
    case 'identity':
    case 'record':
      return [source.name]
    case 'header':
      return ['header', source.name]
    case 'parameter':
      return ['params', source.name]
    case 'initial':
      return ['init', source.name]
    case 'port':
      return ['ports', source.name]
    case 'position':
      return ['extension']
    case 'route':
      return ['extension', 'polyline']
    case 'output':
      return ['mon']
  }
}

/** The record of row `id`: its table and row, its JSON text, and that text's offset in the file. */
export function recordOf(kase: Case, id: string) {
  const located = kase.locate(id)
  if (!located) throw failure('invalid-input', 'This element no longer exists.')
  const { table, row } = located
  const array = table.shape.array === null ? undefined : kase.arrays[table.shape.array]!
  const record = table.records[row]!
  const start = array ? array.starts[record]! : 0
  const end = array ? array.ends[record]! : kase.file.length
  const text = decoder.decode(kase.file.subarray(start, end))
  return { table, row, text, offset: textOffset(kase, start) }
}

/** Row `id`'s record, or its `field`'s value, or the record's first character without one. */
export function sourceRange(kase: Case, id: string, field?: string): SourceRange {
  const record = recordOf(kase, id)
  if (!field) return { offset: record.offset, length: record.text.length }
  const plan = record.table.shape.plan.get(field)
  const node = plan && findNodeAtLocation(parseTree(record.text)!, nativePath(plan))
  return node
    ? { offset: record.offset + node.offset, length: node.length }
    : { offset: record.offset, length: 1 }
}

export function editable(plan: FieldPlan): boolean {
  return !['identity', 'output'].includes(plan.source.kind)
}

/** The edit setting `field` of row `id` to `input`; against `recordText`, at offset 0, if given. */
export function editField(
  kase: Case,
  id: string,
  field: string,
  input: Value,
  recordText?: string,
): SourceEdit[] {
  const original = recordOf(kase, id)
  const record = recordText === undefined ? original : { ...original, text: recordText, offset: 0 }
  const plan = record.table.shape.plan.get(field)
  if (!plan || !editable(plan))
    throw failure('invalid-input', 'Edit identities and structural changes in JSON.')
  const definition = plan.definition
  const type = definition.type
  let value: unknown = input
  if (value !== null) {
    if (typeof type === 'string') {
      const valid =
        type === 'text'
          ? typeof value === 'string'
          : type === 'boolean'
            ? typeof value === 'boolean'
            : typeof value === 'number' &&
              Number.isFinite(value) &&
              (type === 'int32'
                ? Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
                : true)
      if (!valid) throw failure('invalid-input', `Expected ${type} for ${field}.`)
    } else if (type.kind === 'reference') {
      const target = typeof value === 'string' ? kase.locate(value) : null
      if (!target || target.table.shape.type !== type.to)
        throw failure('invalid-input', `Choose an existing ${type.to} reference.`)
      value = kase.native(target.table, target.row)
    } else if (plan.source.kind === 'position') {
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !value.every((n) => typeof n === 'number' && Number.isFinite(n))
      )
        throw failure('invalid-input', 'A position is [longitude, latitude].')
    } else if (plan.source.kind === 'route') {
      if (
        !Array.isArray(value) ||
        !value.every(
          (point) =>
            Array.isArray(point) &&
            point.length === 2 &&
            point.every((n) => typeof n === 'number' && Number.isFinite(n)),
        )
      )
        throw failure('invalid-input', 'A route is an array of [longitude, latitude] points.')
    }
  } else if (!definition.nullable || plan.required)
    throw failure('invalid-input', 'This field cannot be null.')
  const paths =
    plan.source.kind === 'position'
      ? [
          { path: ['extension', 'longitude'], value: Array.isArray(value) ? value[0] : null },
          { path: ['extension', 'latitude'], value: Array.isArray(value) ? value[1] : null },
        ]
      : [{ path: nativePath(plan), value }]
  // An existing value's token alone is replaced; anything else is inserted through jsonc-parser.
  if (paths.length === 1) {
    const node = findNodeAtLocation(parseTree(record.text)!, paths[0]!.path)
    if (node) {
      const text =
        type === 'float64' && typeof value === 'number' ? realText(value) : JSON.stringify(value)
      return [{ offset: record.offset + node.offset, length: node.length, text }]
    }
  }
  let next = record.text
  for (const item of paths) {
    next = withValue(next, item.path, item.value)
    if (typeof item.value === 'number' && (type === 'float64' || plan.source.kind === 'position')) {
      const node = findNodeAtLocation(parseTree(next)!, item.path)!
      next = apply(next, [{ offset: node.offset, length: node.length, text: realText(item.value) }])
    }
  }
  return [minimal(record.text, next, record.offset)]
}

/** Each value present but invalid or required but missing, and any signal with two drivers. */
export function diagnose(kase: Case): Issue[] {
  const issues: Issue[] = []
  for (const table of kase.tables.values()) {
    for (let row = 0; row < table.records.length && issues.length < 100; row++) {
      let record: ReturnType<typeof recordOf> | undefined
      let tree: ReturnType<typeof parseTree>
      for (const plan of table.shape.plan.values()) {
        if (
          plan.definition.sampled ||
          plan.source.kind === 'identity' ||
          kase.cell(table, plan.name, row) !== null
        )
          continue
        const id = kase.id(table, row)
        if (!record) {
          record = recordOf(kase, id)
          tree = parseTree(record.text)
        }
        const node = tree && findNodeAtLocation(tree, nativePath(plan))
        if (
          (node && node.value !== null && plan.source.kind !== 'position') ||
          (plan.required && (!node || node.value === null))
        ) {
          const type = plan.definition.type
          issues.push({
            ...sourceRange(kase, id, plan.name),
            id,
            field: plan.name,
            severity: 'error',
            message:
              typeof type === 'object' && type.kind === 'reference'
                ? 'Missing or invalid ' + type.to + ' reference.'
                : 'Invalid ' + plan.name + ' value.',
          })
        }
        if (issues.length >= 100) break
      }
    }
  }
  try {
    kase.checkSignals()
  } catch (error) {
    issues.push({
      offset: 0,
      length: 1,
      severity: 'error',
      message: message(error),
    })
  }
  return issues
}
