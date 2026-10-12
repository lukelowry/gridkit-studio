import { findNodeAtLocation, getLocation, parseTree, visit } from 'jsonc-parser'

import type { CaseSymbol, SourceContext } from '../shared/messages.js'
import { withUnit } from '../shared/schema.js'
import type { Case, Table } from './case.js'
import { CASE, type Catalog, type FieldPlan, SIGNAL } from './definition.js'
import { nativePath, recordAt, sourceRange, textOffset, utf8Width } from './edits.js'
import { ARRAYS } from './parse.js'

/** The case's outline as its file lays it out: each array, holding its records in file order, each
 *  named by its id, up to `limit` records in all, as VS Code's `json.maxItemsComputed` sets for a
 *  JSON file's outline. An array listing fewer than it holds says so. The ranges come from the
 *  offsets the parse kept, counted on through each array once, so no record's text is decoded. */
export function outline(kase: Case, signal: AbortSignal, limit = Infinity): CaseSymbol[] {
  const symbols: CaseSymbol[] = []
  let room = limit
  for (const name of ARRAYS) {
    const array = kase.arrays[name]
    if (!array) continue
    // Each record's row, by its place in the array.
    const rows: ({ table: Table; row: number } | undefined)[] = []
    for (const table of kase.tables.values())
      if (table.shape.array === name)
        for (let row = 0; row < table.records.length; row++)
          rows[table.records[row]!] = { table, row }
    // UTF-16 offsets, as VS Code counts, of the array's ascending byte offsets.
    let byte = array.open
    let chars = textOffset(kase, byte)
    const at = (to: number) => {
      for (; byte < to; chars++) {
        const width = utf8Width(kase.file[byte]!)
        byte += width
        if (width === 4) chars++
      }
      return chars
    }
    const open = at(array.open)
    const children: CaseSymbol[] = []
    let held = 0
    for (let record = 0; record < array.starts.length; record++) {
      if ((record & 4095) === 0) signal.throwIfAborted()
      const found = rows[record]
      if (!found) continue
      held++
      if (children.length >= room) continue
      const offset = at(array.starts[record]!)
      children.push({
        name: kase.id(found.table, found.row),
        detail: found.table.shape.definition.label ?? found.table.shape.type,
        offset,
        length: at(array.ends[record]!) - offset,
      })
    }
    room -= children.length
    symbols.push({
      name,
      detail: children.length < held ? `${children.length} of ${held}` : String(held),
      offset: open,
      // The array's end, found from the nearest checkpoint rather than counted on to.
      length: textOffset(kase, array.close + 1) - open,
      children,
    })
  }
  return symbols
}

/** What is at UTF-16 `offset`: its row and field, their range, the row a reference names, and the
 *  fields that complete beside it. */
export function sourceContext(kase: Case, offset: number): SourceContext {
  for (const table of kase.tables.values()) {
    if (!table.shape.array) continue
    const records = kase.arrays[table.shape.array]!
    const indexes = table.records
    let low = 0
    let high = indexes.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (textOffset(kase, records.starts[indexes[mid]!]!) <= offset) low = mid + 1
      else high = mid
    }
    const row = low - 1
    if (row < 0 || offset > textOffset(kase, records.ends[indexes[row]!]!)) continue
    const id = kase.id(table, row)
    const record = recordAt(kase, table, row)
    const location = getLocation(record.text, offset - record.offset)
    const path = location.path.filter((key): key is string => typeof key === 'string')
    const group = path.slice(0, -1)
    const plans = [...table.shape.plan.values()]
    const plan = plans.find((plan) => JSON.stringify(nativePath(plan)) === JSON.stringify(path))
    const range = plan
      ? sourceRange(kase, id, plan.name)
      : { offset: record.offset, length: record.text.length }
    let reference: string | undefined
    if (
      plan &&
      typeof plan.definition.type === 'object' &&
      plan.definition.type.kind === 'reference'
    ) {
      const node = findNodeAtLocation(parseTree(record.text)!, path)
      if (typeof node?.value === 'number') reference = plan.definition.type.to + '/' + node.value
    }
    return {
      element: { id, ...(plan ? { field: plan.name } : {}) },
      type: table.shape.type,
      range,
      reference,
      completions: plans
        .filter(
          (plan) =>
            !plan.definition.sampled &&
            JSON.stringify(nativePath(plan).slice(0, -1)) === JSON.stringify(group),
        )
        .map((plan) => completion(nativePath(plan).at(-1)!, plan)),
    }
  }
  return { completions: [] }
}

/** The fields that complete at `offset`, from `text` alone, so it may be invalid JSON. */
export function completionsAt(
  catalog: Catalog,
  text: string,
  offset: number,
): SourceContext['completions'] {
  const location = getLocation(text, offset)
  if (!location.isAtPropertyKey) return []
  const path = location.path
  const array = typeof path[0] === 'string' ? path[0] : ''
  const row = typeof path[1] === 'number' ? path[1] : undefined
  const type =
    array === 'buses'
      ? catalog.bus
      : array === 'signals'
        ? SIGNAL
        : row !== undefined
          ? classOf(text, array, row)
          : CASE
  const shape = type === undefined ? undefined : catalog.shapes.get(type)
  if (!shape) return []
  const group = path.slice(row === undefined ? 0 : 2, -1)
  const fields = [...shape.plan.values()]
    .filter((plan) => !plan.definition.sampled)
    .map((plan) => [nativePath(plan), plan] as const)
    .filter(([path]) => JSON.stringify(path.slice(0, -1)) === JSON.stringify(group))
    .map(([path, plan]) => completion(path.at(-1)!, plan))
  return [...new Map(fields.map((field) => [field.name, field])).values()]
}

/** The `class` of record `row` of `array`, read up to it alone. Depth and records are counted as the
 *  scan goes, so nothing is built, and it stops at the record. */
function classOf(text: string, array: string, row: number): string | undefined {
  const done = {}
  let value: unknown
  /** How deep the scan is: 1 among the case's own keys, 3 among a record's. */
  let depth = 0
  let key = ''
  let within = false
  let records = -1
  try {
    visit(text, {
      onObjectBegin: () => {
        if (within && depth === 2 && ++records > row) throw done
        depth++
      },
      onObjectEnd: () => void depth--,
      onArrayBegin: () => {
        if (depth === 1 && key === array) within = true
        depth++
      },
      onArrayEnd: () => {
        if (--depth === 1) within = false
      },
      onObjectProperty: (name) => {
        if (depth === 1 || depth === 3) key = name
      },
      onLiteralValue: (literal) => {
        if (within && depth === 3 && records === row && key === 'class') {
          value = literal
          throw done
        }
      },
    })
  } catch (error) {
    if (error !== done) throw error
  }
  return typeof value === 'string' ? value : undefined
}

/** The completion `name` offers for `plan`: its type and unit, and its description. */
function completion(name: string, plan: FieldPlan): SourceContext['completions'][number] {
  const { type, unit, description } = plan.definition
  return {
    name,
    detail: withUnit(typeof type === 'string' ? type : type.kind, unit),
    description,
  }
}
