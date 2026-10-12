import { type Failure, failure } from '@latkit/model'
import { findNodeAtLocation, type JSONPath, modify, parseTree } from 'jsonc-parser'

import { message } from '../shared/errors.js'
import type { Value } from '../shared/messages.js'
import type { Issue, SourceEdit, SourceRange } from '../shared/messages.js'
import type { Case, Table } from './case.js'
import { isInt32, STEP_RECORDS } from './columns.js'
import { CASE, type FieldPlan } from './definition.js'
import { Turns } from './turns.js'

const decoder = new TextDecoder()
const OPEN_OBJECT = 0x7b
const SPACE = 0x20
const TAB = 0x09
const checkpoints = new WeakMap<Case, { bytes: number[]; chars: number[] }>()

/** A real as GridKit reads one: always with a fraction or an exponent, so 0 is 0.0. */
export function realText(value: number): string {
  const text = JSON.stringify(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}

/** How many bytes the UTF-8 character whose first byte is `first` takes; one of four takes two
 *  UTF-16 units, the others one. */
export const utf8Width = (first: number) =>
  first < 128 ? 1 : first < 224 ? 2 : first < 240 ? 3 : 4

/** The UTF-16 offset of `byte` in the case's file, as VS Code counts. Checkpoints every 4 KiB fall on
 *  code-point boundaries, so only the bytes past one are decoded. */
export function textOffset(kase: Case, byte: number): number {
  let map = checkpoints.get(kase)
  if (!map) {
    map = { bytes: [0], chars: [0] }
    let chars = 0
    let next = 4096
    for (let at = 0; at < kase.file.length;) {
      const width = utf8Width(kase.file[at]!)
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

/** How far a walk through the file counts on, character by character, before it jumps instead from
 *  the nearest checkpoint. */
const WALK_BYTES = 4096

/** The UTF-16 offsets, as VS Code counts, of ascending byte offsets of the case's file: each counted
 *  on from the last, near, or found from a checkpoint, far; so a walk through the file is linear
 *  however many offsets it asks for. */
export function textOffsets(kase: Case): (byte: number) => number {
  let byte = -1
  let chars = 0
  return (to) => {
    if (byte < 0 || to < byte || to - byte > WALK_BYTES) {
      byte = to
      return (chars = textOffset(kase, to))
    }
    for (; byte < to; chars++) {
      const width = utf8Width(kase.file[byte]!)
      byte += width
      if (width === 4) chars++
    }
    return chars
  }
}

/** `text` with `edits` applied; each edit's offset is into `text` as given. One pass joins what lies
 *  between the edits with their texts, so a batch of any size copies the text once. Insertions at
 *  one offset land last first, as when each is applied in turn. */
export function apply(text: string, edits: readonly SourceEdit[]): string {
  if (edits.length === 1) {
    const [edit] = edits as [SourceEdit]
    return text.slice(0, edit.offset) + edit.text + text.slice(edit.offset + edit.length)
  }
  const order = edits
    .map((edit, i) => ({ edit, i }))
    .sort((a, b) => a.edit.offset - b.edit.offset || b.i - a.i)
  const parts: string[] = []
  let at = 0
  for (const { edit } of order) {
    parts.push(text.slice(at, edit.offset), edit.text)
    at = Math.max(at, edit.offset + edit.length)
  }
  parts.push(text.slice(at))
  return parts.join('')
}

/** `text` with `value` set at `path` by jsonc-parser, which leaves the rest unformatted. */
export function withValue(text: string, path: JSONPath, value: unknown): string {
  return apply(
    text,
    nested(() => modify(text, path, value, {})).map((edit) => ({
      offset: edit.offset,
      length: edit.length,
      text: edit.content,
    })),
  )
}

/** Whether the UTF-16 unit `unit` is the first, or the second, of a surrogate pair. */
const leads = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const trails = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

/** The one edit that turns `before`, at `offset`, into `after`: the span where they differ, widened
 *  to whole characters, so neither end splits a surrogate pair. */
export function minimal(before: string, after: string, offset: number): SourceEdit {
  let start = 0
  let end = before.length
  let stop = after.length
  while (start < end && start < stop && before[start] === after[start]) start++
  if (start > 0 && leads(before.charCodeAt(start - 1))) start--
  while (end > start && stop > start && before[end - 1] === after[stop - 1]) {
    end--
    stop--
  }
  if (end < before.length && trails(before.charCodeAt(end))) {
    end++
    stop++
  }
  return { offset: offset + start, length: end - start, text: after.slice(start, stop) }
}

/** What `read` gives of a record's text by jsonc-parser, which recurses as deep as the record
 *  nests: a record nested deeper than the stack holds is refused, as its own problem. */
export function nested<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof RangeError && /call stack/i.test(error.message))
      throw failure('invalid-input', 'This record nests its values too deeply to read.')
    throw error
  }
}

/** The tree of a record's `text`. */
export const treeOf = (text: string) => nested(() => parseTree(text)!)

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
  return recordAt(kase, located.table, located.row)
}

/** The record of `row` of `table`, as `recordOf` gives it, found by its place alone. The case's own
 *  row is no record: its fields are in its `header` and `params`, each read alone, as `placeOf`
 *  finds them, and the row stands in its header. */
export function recordAt(kase: Case, table: Table, row: number) {
  if (table.shape.array === null) {
    const header = objectOf(kase, 'header')
    return { table, row, text: header?.text ?? '', offset: header?.offset ?? 0 }
  }
  const array = kase.arrays[table.shape.array]!
  const record = table.records[row]!
  const start = array.starts[record]!
  const text = decoder.decode(kase.file.subarray(start, array.ends[record]!))
  return { table, row, text, offset: textOffset(kase, start) }
}

/** A part of the file a field is written in: its JSON text, the text's offset in the file, and the
 *  field's path in it. */
interface Place {
  readonly text: string
  readonly offset: number
  readonly path: JSONPath
}

/** The case's own object `name`, its `header` or its `params`, where it writes one. */
function objectOf(kase: Case, name: string): Omit<Place, 'path'> | undefined {
  const member = kase.member(name)
  if (!member || kase.file[member.value] !== OPEN_OBJECT) return undefined
  return {
    text: decoder.decode(kase.file.subarray(member.value, member.end)),
    offset: textOffset(kase, member.value),
  }
}

/** Which of the case's own objects its field `plan` is written in, and where in that object. */
const objectNameOf = (plan: FieldPlan) => nativePath(plan)[0]!
const pathIn = (plan: FieldPlan) => nativePath(plan).slice(1)

/** Where field `plan` of row `row` of `table` is written. A record holds its own fields; the case's
 *  are in its `header` and `params`, each read alone, so nothing of the case's own reads the whole
 *  file. Undefined where the case writes no such object. */
function placeOf(kase: Case, table: Table, row: number, plan: FieldPlan): Place | undefined {
  if (table.shape.array === null) {
    const object = objectOf(kase, objectNameOf(plan))
    return object && { ...object, path: pathIn(plan) }
  }
  const { text, offset } = recordAt(kase, table, row)
  return { text, offset, path: nativePath(plan) }
}

/** Row `id`'s record, or its `field`'s value, or the record's first character without one. */
export function sourceRange(kase: Case, id: string, field?: string): SourceRange {
  const record = recordOf(kase, id)
  if (!field) return { offset: record.offset, length: Math.max(1, record.text.length) }
  const plan = record.table.shape.plan.get(field)
  const place = plan && placeOf(kase, record.table, record.row, plan)
  const node = place && findNodeAtLocation(treeOf(place.text), place.path)
  return node
    ? { offset: place.offset + node.offset, length: node.length }
    : { offset: place?.offset ?? record.offset, length: 1 }
}

/** Whether a field's value is edited in place: not an identity or output, nor a found object. */
export function editable(plan: FieldPlan): boolean {
  const { source } = plan
  return !['identity', 'output'].includes(source.kind) && !(source.kind === 'found' && source.json)
}

/** `input` as field `plan` holds it, checked, with a reference resolved by `resolve`, or the case. */
function valueFor(
  kase: Case,
  plan: FieldPlan | undefined,
  input: Value,
  resolve?: (id: string, type: string) => string | number | undefined,
): { plan: FieldPlan; value: unknown } {
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
  return { plan, value }
}

/** The edit setting field `plan`, at `place`, to `value`. */
function edited(place: Place, plan: FieldPlan, value: unknown): SourceEdit {
  const { text, offset, path } = place
  // An existing value's token alone is replaced; anything else is inserted through jsonc-parser.
  const node = findNodeAtLocation(treeOf(text), path)
  // A key the catalog does not know keeps how it was written: GridKit may read an integer there.
  const integer =
    plan.source.kind === 'found' &&
    !!node &&
    !/[.eE]/.test(text.slice(node.offset, node.offset + node.length)) &&
    Number.isInteger(value)
  const real = plan.definition.type === 'float64' && typeof value === 'number' && !integer
  if (node)
    return {
      offset: offset + node.offset,
      length: node.length,
      text: real ? realText(value as number) : JSON.stringify(value),
    }
  let next = withValue(text, path, value)
  if (real) {
    const inserted = findNodeAtLocation(treeOf(next), path)!
    next = apply(next, [
      { offset: inserted.offset, length: inserted.length, text: realText(value as number) },
    ])
  }
  return minimal(text, next, offset)
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
  const located = kase.locate(id)
  if (!located) throw failure('invalid-input', 'This element no longer exists.')
  if (located.table.shape.array === null) return editCase(kase, new Map([[field, input]]), resolve)
  const { plan, value } = valueFor(kase, located.table.shape.plan.get(field), input, resolve)
  const place =
    recordText === undefined
      ? placeOf(kase, located.table, located.row, plan)!
      : { text: recordText, offset: 0, path: nativePath(plan) }
  return [edited(place, plan, value)]
}

/** The edits setting the case's own fields to `values`: each of its objects they are in, header or
 *  params, changed in one edit, or, where the case writes none, made with them. */
export function editCase(
  kase: Case,
  values: ReadonlyMap<string, Value>,
  resolve?: (id: string, type: string) => string | number | undefined,
): SourceEdit[] {
  const shape = kase.table(CASE).shape
  const byObject = new Map<string, { plan: FieldPlan; value: unknown }[]>()
  for (const [field, input] of values) {
    const set = valueFor(kase, shape.plan.get(field), input, resolve)
    const name = objectNameOf(set.plan)
    byObject.set(name, [...(byObject.get(name) ?? []), set])
  }
  const edits: SourceEdit[] = []
  const made: string[] = []
  for (const [name, sets] of byObject) {
    const object = objectOf(kase, name)
    if (!object) {
      const members = sets.map(
        ({ plan, value }) =>
          `${JSON.stringify(pathIn(plan).join('.'))}: ${plan.definition.type === 'float64' && typeof value === 'number' ? realText(value) : JSON.stringify(value)}`,
      )
      made.push(`${JSON.stringify(name)}: {${members.join(', ')}}`)
      continue
    }
    let after = object.text
    for (const { plan, value } of sets)
      after = apply(after, [edited({ text: after, offset: 0, path: pathIn(plan) }, plan, value)])
    edits.push(minimal(object.text, after, object.offset))
  }
  if (made.length) edits.push(membersMade(kase, made))
  return edits.sort((a, b) => a.offset - b.offset)
}

/** The edit that writes `made`, members of the case's own object, first among its members, as
 *  indented as the one they go before; in a case with none, between its braces. */
function membersMade(kase: Case, made: readonly string[]): SourceEdit {
  const [first] = kase.members
  if (!first) return { offset: textOffset(kase, kase.close), length: 0, text: made.join(', ') }
  let indent = first.start
  while (indent > 0 && (kase.file[indent - 1] === SPACE || kase.file[indent - 1] === TAB)) indent--
  const spacing = decoder.decode(kase.file.subarray(indent, first.start))
  return {
    offset: textOffset(kase, first.start),
    length: 0,
    text: made.map((member) => `${member},\n${spacing}`).join(''),
  }
}

/** Each value present but invalid or required but missing, any signal with two drivers, and, as
 *  warnings, each class and field the catalog does not know. */
const diagnoses = new WeakMap<Case, Issue[]>()

/** The case's issues, which every caller shares of the same immutable source. Found a slice at a
 *  time, yielding to topology queries between, and cancelled between slices. */
export async function diagnose(kase: Case, signal: AbortSignal): Promise<Issue[]> {
  signal.throwIfAborted()
  const cached = diagnoses.get(kase)
  if (cached) return cached
  const work = new Turns(signal)
  const steps = diagnostics(kase)
  for (let step = 0; ; step++) {
    const next = steps.next()
    if (next.done) {
      diagnoses.set(kase, next.value)
      return next.value
    }
    if ((step & STEP_RECORDS) === 0) await work.step()
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
    for (let row = 0; row < table.records.length; row++) {
      yield
      let record: ReturnType<typeof recordOf> | undefined
      let tree: ReturnType<typeof treeOf> | undefined
      for (const plan of table.shape.plan.values()) {
        if (row === 0) yield
        // A field the catalog does not know is never required, and holds what it is written as.
        if (
          plan.definition.sampled ||
          plan.source.kind === 'identity' ||
          plan.source.kind === 'found' ||
          kase.cell(table, plan.name, row) !== null
        )
          continue
        const supplied = table.fields.get(plan.name)?.supplied
        let invalid: boolean
        if (supplied) invalid = plan.required === true || supplied(row)
        else {
          // Ordinary records use presence bits instead of reparsing absent optional values.
          if (!record) {
            record = recordAt(kase, table, row)
            try {
              tree = treeOf(record.text)
            } catch (error) {
              // A record too deep to read is the one problem it has.
              issues.push({
                offset: record.offset,
                length: record.text.length,
                id: kase.id(table, row),
                severity: 'error',
                message: message(error),
              })
              break
            }
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
      }
    }
  }
  try {
    kase.checkSignals()
  } catch (error) {
    // A signal two outputs drive is said where it is.
    const target = (error as Failure).target
    issues.push({
      ...(target?.kind === 'row' ? sourceRange(kase, target.id) : { offset: 0, length: 1 }),
      ...(target?.kind === 'row' && { id: target.id }),
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
              (type !== 'int32' || isInt32(value))
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
