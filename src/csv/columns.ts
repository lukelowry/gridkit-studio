import type { FieldRef, Model } from '@latkit/model'

import { canonicalMonitor, classMonitors } from '../gridkit/classes.js'
import { classId } from '../gridkit/ids.js'
import type { Case } from '../gridkit/validate.js'

export interface CsvColumn {
  column: number
  field: FieldRef
  element: number
}
const key = (text: string) => text.normalize('NFC').toLowerCase()
/** Match complete expected headers. Underscores in names/IDs never become separators. */
export function bindColumns(
  raw: Case,
  model: Model,
  headers: readonly string[],
  declaredOnly = true,
): CsvColumn[] {
  const expected = new Map<string, Omit<CsvColumn, 'column'>[]>()
  const declare = (kind: string, id: string, identity: string, mon: unknown, element: number) => {
    if (!declaredOnly) mon = [...classMonitors(kind), ...(Array.isArray(mon) ? mon : [])]
    if (!Array.isArray(mon)) return
    for (const name of new Set(
      mon
        .filter((value): value is string => typeof value === 'string')
        .map((name) => canonicalMonitor(kind, name)),
    )) {
      if (!model.classes.find((cls) => cls.id === id)?.signals.some((signal) => signal.id === name))
        continue
      const header = key(`${kind}_${identity}_${name}`)
      if (header.includes(',') || /[\r\n"]/.test(header))
        throw new Error(
          'A monitored element name contains characters GridKit cannot encode in a CSV header.',
        )
      const queue = expected.get(header) ?? []
      queue.push({ field: { classId: id, source: 'signal', id: name }, element })
      expected.set(header, queue)
    }
  }
  raw.buses.forEach((bus, i) => declare('Bus', 'bus', bus.name, bus.mon, i))
  const counts = new Map<string, number>()
  for (const device of raw.devices) {
    const id = classId(device.class)
    const index = counts.get(id) ?? 0
    counts.set(id, index + 1)
    declare(device.class, id, device.id, device.mon, index)
  }
  // GridKit traverses buses and each device class in case order. Repeated complete
  // headers are usable only when all declared occurrences are present.
  const actual = new Map<string, number>()
  for (const name of headers.slice(1)) actual.set(key(name), (actual.get(key(name)) ?? 0) + 1)
  for (const [name, count] of actual)
    if (!expected.has(name) || expected.get(name)!.length !== count) {
      throw new Error(`CSV column cannot be mapped unambiguously to this case: ${name}`)
    }
  const cursors = new Map<string, number>()
  return headers.slice(1).map((name, i) => {
    const normalized = key(name)
    const cursor = cursors.get(normalized) ?? 0
    cursors.set(normalized, cursor + 1)
    return { column: i + 1, ...expected.get(normalized)![cursor] }
  })
}
