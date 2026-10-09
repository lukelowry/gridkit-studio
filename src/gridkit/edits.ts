import { setImmediate } from 'node:timers/promises'

import { failure, type Value } from '@latkit/model'
import { findNodeAtLocation, type JSONPath, modify, parseTree } from 'jsonc-parser'

import { message } from '../shared/format.js'
import type { Issue, SourceEdit, SourceRange } from '../shared/messages.js'
import type { Case } from './case.js'
import type { FieldPlan } from './definition.js'

const decoder = new TextDecoder()
const checkpoints = new WeakMap<Case, { bytes: number[]; chars: number[] }>()

/** A real as GridKit reads one: always with a fraction or an exponent, so 0 is 0.0. */
export function realText(value: number): string {
  const text = JSON.stringify(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}

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
    case 'extension':
      return ['extension', source.name]
    case 'found':
      return [...source.path]
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

/** Whether a field's value is edited in place: not an identity or output, nor a found object. */
export function editable(plan: FieldPlan): boolean {
  const { source } = plan
  return !['identity', 'output'].includes(source.kind) && !(source.kind === 'found' && source.json)
}

/** The edit setting `field` of row `id` to `input`; against `recordText`, at offset 0, if given. */
export function editField(
  kase: Case,
  id: string,
  field: string,
  input: Value,
  recordText?: string,
  resolve?: (id: string, type: string) => string | number | undefined,
): SourceEdit[] {
  const original = recordOf(kase, id)
  const record = recordText === undefined ? original : { ...original, text: recordText, offset: 0 }
  const plan = record.table.shape.plan.get(field)
  if (!plan || !editable(plan))
    throw failure('invalid-input', 'Edit identities and structural changes in JSON.')
  const value = fieldValue(
    plan,
    input,
    resolve ??
      ((id, type) => {
        const target = kase.locate(id)
        return target?.table.shape.type === type ? kase.native(target.table, target.row) : undefined
      }),
  )
  const type = plan.definition.type
  const path = nativePath(plan)
  const real = type === 'float64' && typeof value === 'number'
  // An existing value's token alone is replaced; anything else is inserted through jsonc-parser.
  const node = findNodeAtLocation(parseTree(record.text)!, path)
  if (node) {
    const text = real ? realText(value as number) : JSON.stringify(value)
    return [{ offset: record.offset + node.offset, length: node.length, text }]
  }
  let next = withValue(record.text, path, value)
  if (real) {
    const inserted = findNodeAtLocation(parseTree(next)!, path)!
    next = apply(next, [
      { offset: inserted.offset, length: inserted.length, text: realText(value as number) },
    ])
  }
  return [minimal(record.text, next, record.offset)]
}

/** Each value present but invalid or required but missing, any signal with two drivers, and, as
 *  warnings, each class and field the catalog does not know. */
const diagnoses = new WeakMap<Case, Issue[]>()

/** All callers share validation of the same immutable source. */
export function diagnose(kase: Case): Issue[] {
  const cached = diagnoses.get(kase)
  if (cached) return cached
  const work = diagnostics(kase)
  let next = work.next()
  while (!next.done) next = work.next()
  diagnoses.set(kase, next.value)
  return next.value
}

/** Background validation yields to topology queries and can be cancelled between slices. */
export async function diagnoseAsync(kase: Case, signal: AbortSignal): Promise<Issue[]> {
  signal.throwIfAborted()
  const cached = diagnoses.get(kase)
  if (cached) return cached
  const work = diagnostics(kase)
  let deadline = performance.now() + 4
  for (;;) {
    signal.throwIfAborted()
    const next = work.next()
    if (next.done) {
      diagnoses.set(kase, next.value)
      return next.value
    }
    if (performance.now() >= deadline) {
      await setImmediate(undefined, { signal })
      deadline = performance.now() + 4
    }
  }
}

function* diagnostics(kase: Case): Generator<void, Issue[]> {
  const issues: Issue[] = []
  for (const table of kase.tables.values())
    if (!kase.catalog.shapes.has(table.shape.type) && table.records.length) {
      const id = kase.id(table, 0)
      issues.push({
        ...sourceRange(kase, id),
        id,
        severity: 'warning',
        message: `${table.shape.type} is not a class GridKit Studio knows; its records are kept as written.`,
      })
    }
  for (const { type, field, row } of kase.found) {
    yield
    const id = kase.id(kase.table(type), row)
    issues.push({
      ...sourceRange(kase, id, field),
      id,
      field,
      severity: 'warning',
      message: `${field} is not a ${type} field GridKit Studio knows; it is kept as written.`,
    })
  }
  for (const table of kase.tables.values()) {
    for (let row = 0; row < table.records.length && issues.length < 100; row++) {
      yield
      let record: ReturnType<typeof recordOf> | undefined
      let tree: ReturnType<typeof parseTree>
      for (const plan of table.shape.plan.values()) {
        if (row === 0) yield
        if (
          plan.definition.sampled ||
          plan.source.kind === 'identity' ||
          kase.cell(table, plan.name, row) !== null
        )
          continue
        const supplied = table.fields.get(plan.name)?.supplied
        let invalid: boolean
        if (supplied) invalid = plan.required === true || supplied(row)
        else {
          // Ordinary records use presence bits instead of reparsing absent optional values.
          if (!record) {
            record = recordOf(kase, kase.id(table, row))
            tree = parseTree(record.text)
          }
          const node = tree && findNodeAtLocation(tree, nativePath(plan))
          invalid = !!(
            (node && node.value !== null) ||
            (plan.required && (!node || node.value === null))
          )
        }
        if (invalid) {
          const id = kase.id(table, row)
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

/** Shared validation for existing fields and newly created records. */
export function fieldValue(
  plan: FieldPlan,
  input: Value,
  resolve: (id: string, type: string) => string | number | undefined,
): unknown {
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
      if (!valid) throw failure('invalid-input', `Expected ${type} for ${plan.name}.`)
    } else if (type.kind === 'reference') {
      const target = typeof value === 'string' ? resolve(value, type.to) : undefined
      if (target === undefined)
        throw failure('invalid-input', `Choose an existing or proposed ${type.to} reference.`)
      value = target
    } else if (type.kind === 'list') {
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
  return value
}
