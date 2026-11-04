/** What is wrong with a case: each value present but invalid or required but missing, each name or
 *  id outside the catalog's rule, any signal with two drivers, and, as warnings, each class and field
 *  the catalog does not know, each value outside the choices it gives, and subsystems, which Studio
 *  does not show. */

import type { SourceError } from '../shared/errors.js'
import { message } from '../shared/errors.js'
import type { Issue } from '../shared/messages.js'
import type { Case } from './case.js'
import { type Column, isValid, valueAt } from './columns.js'
import type { FieldPlan } from './definition.js'
import type { Span } from './offsets.js'
import { sourceRange, textOffset } from './places.js'
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
    if (!kase.catalog.shapes.has(table.shape.type) && table.records.length) {
      const id = kase.entity(table, 0)
      issues.push({
        ...sourceRange(kase, id),
        entity: id,
        severity: 'warning',
        message: `${table.shape.type} is not a class GridKit Studio knows; its records are kept as written.`,
      })
    }
  for (const { type, field, row } of kase.found) {
    yield
    const id = kase.entity(kase.table(type), row)
    issues.push({
      ...sourceRange(kase, id, field),
      entity: id,
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
        const id = kase.entity(table, row)
        issues.push({
          ...sourceRange(kase, id, plan.name),
          entity: id,
          field: plan.name,
          severity: 'warning',
          message: `${kase.cell(table, plan.name, row)} is not a ${table.shape.type} ${plan.name} GridKit Studio knows; it is kept as written.`,
        })
      }
    }
  for (const table of kase.tables.values())
    for (const plan of table.shape.plan.values()) {
      const column =
        plan.allowed && (plan.source.kind === 'identity' ? table.ids : table.fields.get(plan.name))
      if (!column) continue
      yield
      for (const [n, row] of unallowed(column, plan.allowed!.pattern).entries()) {
        if ((n & STEP_RECORDS) === 0) yield
        const id = kase.entity(table, row)
        issues.push({
          ...sourceRange(kase, id, plan.source.kind === 'identity' ? undefined : plan.name),
          entity: id,
          ...(plan.source.kind !== 'identity' && { field: plan.name }),
          severity: 'error',
          message: `${plan.name} may contain ${plan.allowed!.rule}.`,
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
      // A field the catalog does not know is never required, and holds what it is written as.
      if (
        plan.definition.kind === 'sampled' ||
        plan.source.kind === 'identity' ||
        plan.source.kind === 'found'
      )
        continue
      const column = table.fields.get(plan.name)
      if (!column) continue
      for (const row of plan.required ? empty(column) : (column.wrong?.() ?? []))
        wrong.push({ row, place: at, plan })
    }
    // Said row by row, a row's fields in their order.
    wrong.sort((a, b) => a.row - b.row || a.place - b.place)
    for (const [n, { row, plan }] of wrong.entries()) {
      if ((n & STEP_RECORDS) === 0) yield
      const id = kase.entity(table, row)
      const definition = plan.definition
      issues.push({
        ...sourceRange(kase, id, plan.name),
        entity: id,
        field: plan.name,
        severity: 'error',
        message:
          definition.kind === 'reference'
            ? 'Missing or invalid ' + definition.target + ' reference.'
            : 'Invalid ' + plan.name + ' value.',
      })
    }
  }
  try {
    kase.checkSignals()
  } catch (error) {
    // A signal two outputs drive is said where it is.
    const target = (error as SourceError).target
    issues.push({
      ...(target?.kind === 'row' ? sourceRange(kase, target.entity) : { offset: 0, length: 1 }),
      ...(target?.kind === 'row' && { entity: target.entity }),
      severity: 'error',
      message: message(error),
    })
  }
  return issues
}

/** The rows of `column` that hold no value: none written, null, or what does not read. */
function empty(column: Column): number[] {
  const rows: number[] = []
  column.chunks.forEach((chunk, c) => {
    for (let at = 0; at < chunk.length; at++)
      if (!isValid(chunk, at)) rows.push(column.starts[c]! + at)
  })
  return rows
}

/** The rows of `column` that hold a value other than one of `choices`. */
function outside(column: Column, choices: readonly string[]): number[] {
  const rows: number[] = []
  column.chunks.forEach((chunk, c) => {
    for (let at = 0; at < chunk.length; at++) {
      const value = valueAt(chunk, at)
      if (value !== null && !choices.includes(String(value))) rows.push(column.starts[c]! + at)
    }
  })
  return rows
}

/** The rows of `column` that hold text `pattern` does not match. */
function unallowed(column: Column, pattern: RegExp): number[] {
  const rows: number[] = []
  column.chunks.forEach((chunk, c) => {
    for (let at = 0; at < chunk.length; at++) {
      const value = valueAt(chunk, at)
      if (typeof value === 'string' && !pattern.test(value)) rows.push(column.starts[c]! + at)
    }
  })
  return rows
}
