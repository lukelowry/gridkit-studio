/** The files a run hands GridKit: its case file and input.json. */

import type { Case } from './case.js'
import { rowCount } from './columns.js'
import { FAULT, type Fault, type Field, type SimulationCommand } from './parameters.js'

type Monitors = ReadonlyMap<string, ReadonlyMap<number, readonly string[]>>

const UTF8 = new TextEncoder()

/** The case file in parts: the case's bytes, its monitor lists replaced and `faults`, device
 *  records, appended. */
export function caseFile(kase: Case, monitors: Monitors, faults: string | null): Uint8Array[] {
  const lists = new Map<string, Map<number, string>>()
  for (const [type, rows] of monitors) {
    const table = kase.table(type)
    const array = table.shape.array!
    const records = lists.get(array) ?? lists.set(array, new Map()).get(array)!
    for (const [row, outputs] of rows) records.set(table.records[row]!, JSON.stringify(outputs))
  }
  const edits: { readonly at: number; readonly end: number; readonly text: string }[] = []
  // GridKit reads sinks from the case, not input.json. Replacing the case's own keeps a run writing
  // only its result file, in its own folder.
  const sink = JSON.stringify([{ file_name: 'results.csv', format: 'csv' }])
  edits.push(
    kase.monitors
      ? { at: kase.monitors.value, end: kase.monitors.end, text: sink }
      : { at: kase.close, end: kase.close, text: `, "monitors": ${sink}` },
  )
  for (const [name, array] of Object.entries(kase.arrays)) {
    const records = lists.get(name)
    for (let record = 0; record < array.starts.length; record++) {
      const list = records?.get(record)
      const from = array.mons[2 * record]!
      if (from > 0) edits.push({ at: from, end: array.mons[2 * record + 1]!, text: list ?? '[]' })
      else if (list !== undefined) {
        const brace = array.ends[record]! - 1
        edits.push({ at: brace, end: brace, text: `, "mon": ${list}` })
      }
    }
  }
  if (faults !== null) {
    const devices = kase.arrays.devices
    const last = (devices?.starts.length ?? 0) - 1
    const at =
      devices === undefined ? kase.close : last < 0 ? devices.open + 1 : devices.ends[last]!
    edits.push({
      at,
      end: at,
      text: devices === undefined ? `, "devices": [${faults}]` : last < 0 ? faults : `, ${faults}`,
    })
  }
  edits.sort((a, b) => a.at - b.at)
  const parts: Uint8Array[] = []
  let at = 0
  for (const edit of edits) {
    parts.push(kase.file.subarray(at, edit.at), UTF8.encode(edit.text))
    at = edit.end
  }
  parts.push(kase.file.subarray(at))
  return parts
}

/** Per type, per row: the native outputs the run selects, in the catalog's order. */
export function monitorsOf(kase: Case, outputs: readonly Field[]): Monitors {
  const monitors = new Map<string, Map<number, string[]>>()
  for (const {
    index: { type },
    name,
    rows,
  } of outputs) {
    const source = kase.table(type).shape.plan.get(name)!.source
    if (source.kind !== 'output') continue
    let byRow = monitors.get(type)
    if (byRow === undefined) monitors.set(type, (byRow = new Map()))
    for (const row of rows) {
      const outputs = byRow.get(row)
      if (outputs === undefined) byRow.set(row, [source.name])
      else outputs.push(source.name)
    }
  }
  for (const [type, byRow] of monitors) {
    const order = kase.table(type).shape.outputOrder
    for (const outputs of byRow.values()) outputs.sort((a, b) => order.get(a)! - order.get(b)!)
  }
  return monitors
}

/** `faults` as device records, initially off, and their IDs, which no fault of the case has:
 *  `fault` alone, else `fault_<bus>`. GridKit names a contingency that failed by its ID. */
export function faultRecords(
  kase: Case,
  faults: readonly Fault[],
): { readonly text: string | null; readonly ids: readonly string[] } {
  const table = kase.tables.get(FAULT)
  const taken = (id: string) => table !== undefined && kase.rowOf(table, id) >= 0
  const ids = faults.map((fault) => {
    const base = faults.length === 1 ? 'fault' : `fault_${fault.bus}`
    let id = base
    for (let n = 2; taken(id); n++) id = `${base}_${n}`
    return id
  })
  const records = faults.map(
    (fault, i) =>
      `{"class": ${JSON.stringify(FAULT)}, "id": ${JSON.stringify(ids[i])}, "ports": {"bus": ${fault.bus}}, ` +
      `"params": {"state0": false, "R": ${realText(fault.resistance)}, "X": ${realText(fault.reactance)}}}`,
  )
  return { text: records.length ? records.join(', ') : null, ids }
}

/** How many faults the case has of its own: the first fault it adds has this ordinal, by which
 *  events name it, and ContingencyAnalysis faults the case's own first. */
export function faultOrdinal(kase: Case): number {
  const faults = kase.tables.get(FAULT)
  return faults === undefined ? 0 : rowCount(faults.starts)
}

/** input.json: the run's options and fault events, and the case file it reads. */
export function inputOf(command: SimulationCommand, caseFile: string, ordinal: number): string {
  const members = command.options.map(({ option, value }) => {
    const text =
      option.type === 'choice'
        ? JSON.stringify(value)
        : option.type === 'integer'
          ? String(value)
          : realText(value as number)
    return `${JSON.stringify(option.id)}: ${text}`
  })
  // A study shares one timing; ContingencyAnalysis names each of its faults in turn itself.
  const fault = command.faults[0]
  const events =
    fault === undefined
      ? []
      : [
          `{"time": ${realText(fault.start)}, "type": "fault_on", "element_id": ${ordinal}}`,
          `{"time": ${realText(fault.start + fault.duration)}, "type": "fault_off", "element_id": ${ordinal}}`,
        ]
  return `{\n  ${[
    ...members,
    `"events": [${events.join(', ')}]`,
    `"system_model_file": ${JSON.stringify(caseFile)}`,
  ].join(',\n  ')}\n}\n`
}

/** A real as GridKit reads one: always with a fraction or an exponent, so 0 is 0.0. */
export function realText(value: number): string {
  const text = JSON.stringify(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}
