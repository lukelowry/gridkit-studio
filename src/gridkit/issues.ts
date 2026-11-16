/** Case diagnostics: errors GridKit would reject, and warnings for what Studio keeps but skips. */

import type { Issue } from '../shared/messages.js'
import type { Case, Table } from './case.js'
import { type Column, isValid, rowCount, valueAt } from './columns.js'
import { type FieldPlan, SIGNAL } from './definition.js'
import type { Span } from './offsets.js'
import { jsonText } from './parse.js'
import { rowRange, textOffset } from './places.js'
import { STEP_RECORDS, Turns } from './turns.js'

type Finding = Span & Omit<Issue, 'start' | 'end'>

const diagnoses = new WeakMap<Case, Finding[]>()

/** Computed in slices at background priority, so view requests go first. */
export async function diagnose(kase: Case, signal: AbortSignal): Promise<Finding[]> {
  signal.throwIfAborted()
  const cached = diagnoses.get(kase)
  if (cached) return cached
  const work = new Turns(signal, true)
  const steps = diagnostics(kase)
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
  // Repeated keys, reported at the repeat. GridKit uses the last value.
  for (const [n, { type, row, start, end }] of kase.repeats.entries()) {
    if ((n & STEP_RECORDS) === 0) yield
    const offset = textOffset(kase, start)
    issues.push({
      offset,
      length: textOffset(kase, end) - offset,
      entity: kase.entity(kase.table(type), row),
      severity: 'warning',
      message: `${jsonText(kase.file, start + 1, end - 1)} is written more than once here; GridKit reads its last value.`,
    })
  }
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
  // Missing required members, reported at the record.
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
    // A required field reports every row without a valid value.
    const wrong: { row: number; place: number; plan: FieldPlan }[] = []
    let place = 0
    for (const plan of table.shape.plan.values()) {
      yield
      const at = place++
      // Outputs are results, not case values, and a missing id already fails the parse.
      if (plan.role === 'output' || plan.role === 'identity') continue
      const column = table.fields.get(plan.name)
      if (!column) continue
      for (const row of plan.required ? empty(column) : (column.wrong?.() ?? []))
        wrong.push({ row, place: at, plan })
    }
    // Report by row, then by field order.
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
  const signals = kase.table(SIGNAL)
  for (const [n, driven] of twiceDriven(kase, signals).entries()) {
    if ((n & STEP_RECORDS) === 0) yield
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

function twiceDriven(kase: Case, signals: Table): number[] {
  /** Drivers per signal row, capped at two. */
  const drivers = new Uint8Array(rowCount(signals.starts))
  for (const table of kase.tables.values())
    for (const port of table.shape.ports) {
      if (port.definition.target !== SIGNAL || port.direction !== 'out') continue
      for (const chunk of table.fields.get(port.name)!.chunks) {
        const reference = chunk as Float64Array
        for (let at = 0; at < reference.length; at++) {
          if (!isValid(reference, at)) continue
          const row = kase.rowOf(signals, reference[at]!)
          if (drivers[row]! < 2) drivers[row]!++
        }
      }
    }
  const rows: number[] = []
  drivers.forEach((count, row) => {
    if (count > 1) rows.push(row)
  })
  return rows
}

function empty(column: Column): number[] {
  return rowsWhere(column, (chunk, at) => !isValid(chunk, at))
}

function outside(column: Column, choices: readonly string[]): number[] {
  return rowsWhere(column, (chunk, at) => {
    const value = valueAt(chunk, at)
    return value !== null && !choices.includes(String(value))
  })
}

function unallowed(column: Column, pattern: RegExp): number[] {
  return rowsWhere(column, (chunk, at) => {
    const value = valueAt(chunk, at)
    return typeof value === 'string' && !pattern.test(value)
  })
}

function rowsWhere(
  column: Column,
  test: (chunk: Column['chunks'][number], at: number) => boolean,
): number[] {
  const rows: number[] = []
  column.chunks.forEach((chunk, c) => {
    for (let at = 0; at < chunk.length; at++) if (test(chunk, at)) rows.push(column.starts[c]! + at)
  })
  return rows
}
