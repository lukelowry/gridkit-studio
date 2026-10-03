// Adapted from gridkit-server d0824fc; native monitor ordering and real-number serialization.
import type { Case } from './case.js'
import { FAULT, type Fault, type Field, type SimulationCommand } from './parameters.js'
type Monitors = ReadonlyMap<string, ReadonlyMap<number, readonly string[]>>
const UTF8 = new TextEncoder()
/** Replace monitor lists and append the fault, preserving all other case bytes. */
export function caseFile(kase: Case, monitors: Monitors, fault: string | null): Uint8Array[] {
  const lists = new Map<string, Map<number, string>>()
  for (const [type, rows] of monitors) {
    const table = kase.table(type)
    const array = table.shape.array!
    const records = lists.get(array) ?? lists.set(array, new Map()).get(array)!
    for (const [row, outputs] of rows) records.set(table.records[row]!, JSON.stringify(outputs))
  }
  const edits: { readonly at: number; readonly end: number; readonly text: string }[] = []
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
  if (fault !== null) {
    const devices = kase.arrays.devices
    const last = (devices?.starts.length ?? 0) - 1
    const at =
      devices === undefined ? kase.close : last < 0 ? devices.open + 1 : devices.ends[last]!
    edits.push({
      at,
      end: at,
      text: devices === undefined ? `, "devices": [${fault}]` : last < 0 ? fault : `, ${fault}`,
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

/** Fault initially off, with a case-unique ID. */
export function faultRecord(kase: Case, fault: Fault): string {
  const faults = kase.tables.get(FAULT)
  let id = 'fault'
  for (let n = 2; faults !== undefined && kase.rowOf(faults, id) >= 0; n++) id = `fault_${n}`
  return (
    `{"class": ${JSON.stringify(FAULT)}, "id": ${JSON.stringify(id)}, "ports": {"bus": ${fault.bus}}, ` +
    `"params": {"state0": false, "R": ${realText(fault.resistance)}, "X": ${realText(fault.reactance)}}}`
  )
}

/** Native fault ordinal: existing faults precede the appended one. */
export function faultOrdinal(kase: Case): number {
  const faults = kase.tables.get(FAULT)
  return faults === undefined ? 0 : faults.starts[faults.starts.length - 1]!
}

export function inputOf(
  command: SimulationCommand,
  caseFile: string,
  output: { readonly file: string; readonly rows: number } | null,
  ordinal: number,
): string {
  const members = command.options.map(({ option, value }) => {
    const text =
      option.type === 'choice'
        ? JSON.stringify(value)
        : option.type === 'integer'
          ? String(value)
          : realText(value as number)
    return `${JSON.stringify(option.id)}: ${text}`
  })
  const { fault } = command
  const events =
    fault === null
      ? []
      : [
          `{"time": ${realText(fault.start)}, "type": "fault_on", "element_id": ${ordinal}}`,
          `{"time": ${realText(fault.start + fault.duration)}, "type": "fault_off", "element_id": ${ordinal}}`,
        ]
  const monitors =
    output === null
      ? []
      : [
          JSON.stringify({
            file_name: output.file,
            ...(command.format === 'csv'
              ? { format: 'csv' }
              : { format: 'arrow_stream', batch_rows: output.rows }),
          }),
        ]
  return `{\n  ${[
    ...members,
    `"events": [${events.join(', ')}]`,
    `"system_model_file": ${JSON.stringify(caseFile)}`,
    `"monitors": [${monitors.join(', ')}]`,
  ].join(',\n  ')}\n}\n`
}

/** A real as GridKit reads one: always with a fraction or an exponent, so 0 is 0.0. */
export function realText(value: number): string {
  const text = JSON.stringify(value)
  return /[.eE]/.test(text) ? text : `${text}.0`
}
