/** What is wrong with a case: each value present but invalid or required but missing, each member
 *  GridKit refuses a record without, each name or id outside the catalog's rule, any signal with
 *  two drivers, and, as warnings, each class and field the catalog does not know, each value
 *  outside the choices it gives, and subsystems, which Studio does not show. */

import type { Issue } from '../shared/messages.js'
import type { Case, Table } from './case.js'
import { type Column, isValid, rowCount, valueAt } from './columns.js'
import { type FieldPlan, SIGNAL } from './definition.js'
import type { Span } from './offsets.js'
import { rowRange, textOffset } from './places.js'
import { STEP_RECORDS, Turns } from './turns.js'

/** An issue where gridkit finds it: a span of the file's text, which the worker places by line
 *  and character. */
type Finding = Span & Omit<Issue, 'start' | 'end'>

/** Each case's findings, which every caller shares of the same immutable source. */
const diagnoses = new WeakMap<Case, Finding[]>()

/** The case's findings. Found a slice at a time in the background, so what a view waits on goes
 *  first, and cancelled between slices. */
export async function diagnose(kase: Case, signal: AbortSignal): Promise<Finding[]> {
  signal.throwIfAborted()
  const cached = diagnoses.get(kase)
  if (cached) return cached
  const work = new Turns(signal, true)
  const steps = diagnostics(kase)
  // Each slice is a field, or STEP_RECORDS of its rows, so the turn is asked of after each.
  for (;;) {
    const next = steps.next()
    if (next.done) {
      diagnoses.set(kase, next.value)
      return next.value
    }
    await work.step()
  }
}

function* diagnostics(kase: Case): Generator<void, Finding[]> {
  const issues: Finding[] = []
  const subsystems = kase.member('subsystems')
  if (subsystems)
    issues.push({
      offset: textOffset(kase, subsystems.start),
      length: textOffset(kase, subsystems.end) - textOffset(kase, subsystems.start),
      severity: 'warning',
      message:
        'GridKit Studio shows the top-level system alone; its subsystems are kept as written.',
    })
  for (const table of kase.tables.values())
    if (!kase.catalog.shapes.has(table.shape.type) && table.records.length)
      issues.push({
        ...rowRange(kase, table, 0),
        entity: kase.entity(table, 0),
        severity: 'warning',
        message: `${table.shape.type} is not a class GridKit Studio knows; its records are kept as written.`,
      })
  for (const { type, field, row } of kase.found) {
    yield
    const table = kase.table(type)
    issues.push({
      ...rowRange(kase, table, row, field),
      entity: kase.entity(table, row),
      field,
      severity: 'warning',
      message: `${field} is not a ${type} field GridKit Studio knows; it is kept as written.`,
    })
  }
  for (const table of kase.tables.values())
    for (const plan of table.shape.plan.values()) {
      const column = plan.choices && table.fields.get(plan.name)
      if (!column) continue
      yield
      for (const [n, row] of outside(column, plan.choices!).entries()) {
        if ((n & STEP_RECORDS) === 0) yield
        issues.push({
          ...rowRange(kase, table, row, plan.name),
          entity: kase.entity(table, row),
          field: plan.name,
          severity: 'warning',
          message: `${kase.cell(table, plan.name, row)} is not a ${table.shape.type} ${plan.name} GridKit Studio knows; it is kept as written.`,
        })
      }
    }
  for (const table of kase.tables.values())
    for (const plan of table.shape.plan.values()) {
      const identity = plan.role === 'identity'
      const column = plan.allowed && (identity ? table.ids : table.fields.get(plan.name))
      if (!column) continue
      yield
      for (const [n, row] of unallowed(column, plan.allowed!.pattern).entries()) {
        if ((n & STEP_RECORDS) === 0) yield
        issues.push({
          ...rowRange(kase, table, row, identity ? undefined : plan.name),
          entity: kase.entity(table, row),
          ...(!identity && { field: plan.name }),
          severity: 'error',
          message: `${plan.name} may contain ${plan.allowed!.rule}.`,
        })
      }
    }
  // Each member GridKit refuses a record without, said where the record that lacks it begins.
  for (const table of kase.tables.values())
    for (const [member, rows] of table.lacks) {
      yield
      for (const [n, row] of rows.entries()) {
        if ((n & STEP_RECORDS) === 0) yield
        issues.push({
          ...rowRange(kase, table, row, member),
          entity: kase.entity(table, row),
          severity: 'error',
          message:
            table.shape.kind === 'case'
              ? `The case has no ${member}.`
              : `A ${table.shape.type} record has no ${member}.`,
        })
      }
    }
  for (const table of kase.tables.values()) {
    // Each field's own wrong rows, which each column found as it decoded. A required field's are
    // those that hold no value at all.
    const wrong: { row: number; place: number; plan: FieldPlan }[] = []
    let place = 0
    for (const plan of table.shape.plan.values()) {
      yield
      const at = place++
      // An output is recorded, not written, and a record without its identity does not read.
      if (plan.role === 'output' || plan.role === 'identity') continue
      const column = table.fields.get(plan.name)
      if (!column) continue
      for (const row of plan.required ? empty(column) : (column.wrong?.() ?? []))
        wrong.push({ row, place: at, plan })
    }
    // Said row by row, a row's fields in their order.
    wrong.sort((a, b) => a.row - b.row || a.place - b.place)
    for (const [n, { row, plan }] of wrong.entries()) {
      if ((n & STEP_RECORDS) === 0) yield
      const definition = plan.definition
      issues.push({
        ...rowRange(kase, table, row, plan.name),
        entity: kase.entity(table, row),
        field: plan.name,
        severity: 'error',
        message:
          definition.kind === 'reference'
            ? 'Missing or invalid ' + definition.target + ' reference.'
            : (plan.required ? 'Missing or invalid ' : 'Invalid ') + plan.name + ' value.',
      })
    }
  }
  // A signal two outputs drive is said where it is.
  const signals = kase.table(SIGNAL)
  const driven = twiceDriven(kase, signals)
  if (driven >= 0) {
    const entity = kase.entity(signals, driven)
    issues.push({
      ...rowRange(kase, signals, driven),
      entity,
      severity: 'error',
      message: `${entity.id} has more than one driver.`,
    })
  }
  return issues
}

/** The row of a signal more than one output port drives: the first so found, as the tables and
 *  their ports come; -1 where each has one driver at most. */
function twiceDriven(kase: Case, signals: Table): number {
  const driven = new Uint8Array(Math.ceil(rowCount(signals.starts) / 8))
  for (const table of kase.tables.values())
    for (const port of table.shape.ports) {
      if (port.definition.target !== SIGNAL || port.direction !== 'out') continue
      for (const chunk of table.fields.get(port.name)!.chunks) {
        const reference = chunk as Float64Array
        for (let at = 0; at < reference.length; at++) {
          if (!isValid(reference, at)) continue
          const row = kase.rowOf(signals, reference[at]!)
          const bit = 1 << (row & 7)
          if ((driven[row >>> 3]! & bit) !== 0) return row
          driven[row >>> 3]! |= bit
        }
      }
    }
  return -1
}

/** The rows of `column` that hold no value: none written, null, or what does not read. */
function empty(column: Column): number[] {
  return rowsWhere(column, (chunk, at) => !isValid(chunk, at))
}

/** The rows of `column` that hold a value other than one of `choices`. */
function outside(column: Column, choices: readonly string[]): number[] {
  return rowsWhere(column, (chunk, at) => {
    const value = valueAt(chunk, at)
    return value !== null && !choices.includes(String(value))
  })
}

/** The rows of `column` that hold text `pattern` does not match. */
function unallowed(column: Column, pattern: RegExp): number[] {
  return rowsWhere(column, (chunk, at) => {
    const value = valueAt(chunk, at)
    return typeof value === 'string' && !pattern.test(value)
  })
}

/** The rows of `column` whose value `is` holds of, by the chunk it is in and its place there. */
function rowsWhere(
  column: Column,
  is: (chunk: Column['chunks'][number], at: number) => boolean,
): number[] {
  const rows: number[] = []
  column.chunks.forEach((chunk, c) => {
    for (let at = 0; at < chunk.length; at++) if (is(chunk, at)) rows.push(column.starts[c]! + at)
  })
  return rows
}
