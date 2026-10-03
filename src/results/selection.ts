import { createReadStream } from 'node:fs'

import type { FieldSelection } from '@latkit/model'

import type { Case } from '../gridkit/case.js'
import { messages } from './arrow.js'
import { csvMessages } from './csv.js'
/** Match native names in catalog/row order, including repeated bus names, as Server's decoder does. */
export async function importedFields(
  kase: Case,
  path: string,
  format: 'arrow' | 'csv',
  signal: AbortSignal,
): Promise<FieldSelection[]> {
  const source = createReadStream(path, { signal })
  const counts = new Map<string, number>()
  try {
    for await (const message of format === 'arrow' ? messages(source) : csvMessages(source)) {
      if (message.kind !== 'schema') throw new Error('Results must start with a schema.')
      for (const field of message.fields.slice(1)) {
        const key = field.name.normalize('NFC').toLowerCase()
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      break
    }
  } finally {
    source.destroy()
  }
  const outputs: FieldSelection[] = []
  for (const table of kase.tables.values()) {
    for (const [field] of table.shape.outputOrder) {
      const rows: number[] = []
      for (let row = 0; row < table.records.length; row++) {
        signal.throwIfAborted()
        const identity =
          table.shape.kind === 'bus' ? kase.cell(table, 'name', row) : kase.native(table, row)
        const key = `${table.shape.type}_${identity}_${field}`.normalize('NFC').toLowerCase()
        const count = counts.get(key) ?? 0
        if (count) {
          rows.push(row)
          counts.set(key, count - 1)
        }
      }
      if (rows.length)
        outputs.push({
          from: table.shape.type,
          select: [field],
          rows: { kind: 'indices', index: table.index, values: Uint32Array.from(rows) },
        })
    }
  }
  if (!outputs.length)
    throw new Error('No result columns match this case. Open the case that produced this file.')
  return outputs
}
