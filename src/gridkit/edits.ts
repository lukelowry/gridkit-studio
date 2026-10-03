import { type Diagnostic, failure, type Value } from '@latkit/model'
import { findNodeAtLocation, modify, parseTree } from 'jsonc-parser'

import type { Case } from './case.js'
import type { FieldPlan, Shape } from './definition.js'

export interface SourceRange {
  offset: number
  length: number
}
export interface SourceEdit extends SourceRange {
  text: string
}
export interface Issue extends SourceRange {
  message: string
  severity: Diagnostic['severity']
  id?: string
  field?: string
}

const decoder = new TextDecoder()
const checkpoints = new WeakMap<Case, { bytes: number[]; chars: number[] }>()
/** Checkpoints always fall on a UTF-8 code-point boundary; VS Code positions count UTF-16 units. */
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
export function nativePath(_shape: Shape, field: FieldPlan): string[] {
  const source = field.source
  switch (source.kind) {
    case 'identity':
      return [source.name]
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
export function sourceRange(kase: Case, id: string, field?: string): SourceRange {
  const record = recordOf(kase, id)
  if (!field) return { offset: record.offset, length: record.text.length }
  const plan = record.table.shape.plan.get(field)
  const node =
    plan && findNodeAtLocation(parseTree(record.text)!, nativePath(record.table.shape, plan))
  return node
    ? { offset: record.offset + node.offset, length: node.length }
    : { offset: record.offset, length: 1 }
}
export function editable(plan: FieldPlan): boolean {
  return !['identity', 'output'].includes(plan.source.kind)
}
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
      : [{ path: nativePath(record.table.shape, plan), value }]
  // Existing scalar values get exact token replacements, retaining every untouched byte.
  // Insertions use jsonc-parser without reformatting; position insertions compose against one record.
  if (paths.length === 1) {
    const node = findNodeAtLocation(parseTree(record.text)!, paths[0]!.path)
    if (node) {
      let text = JSON.stringify(value)
      if (type === 'float64' && typeof value === 'number' && !/[.eE]/.test(text)) text += '.0'
      return [{ offset: record.offset + node.offset, length: node.length, text }]
    }
  }
  let next = record.text
  for (const item of paths) {
    for (const edit of modify(next, item.path, item.value, {}).reverse())
      next = next.slice(0, edit.offset) + edit.content + next.slice(edit.offset + edit.length)
    if (typeof item.value === 'number' && (type === 'float64' || plan.source.kind === 'position')) {
      const node = findNodeAtLocation(parseTree(next)!, item.path)!
      let token = JSON.stringify(item.value)
      if (!/[.eE]/.test(token)) token += '.0'
      next = next.slice(0, node.offset) + token + next.slice(node.offset + node.length)
    }
  }
  let start = 0
  let end = record.text.length
  let stop = next.length
  while (start < end && start < stop && record.text[start] === next[start]) start++
  while (end > start && stop > start && record.text[end - 1] === next[stop - 1]) {
    end--
    stop--
  }
  return [{ offset: record.offset + start, length: end - start, text: next.slice(start, stop) }]
}
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
        const node = tree && findNodeAtLocation(tree, nativePath(table.shape, plan))
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
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return issues
}
