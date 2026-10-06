import { createReadStream } from 'node:fs'

import type { FieldSelection } from '@latkit/model'

import type { Case } from '../gridkit/index.js'
import { messages } from './arrow.js'
import { csvMessages } from './csv.js'
import { columnName, fold } from './decode.js'

/** The outputs a results file records, matched to the case's rows in catalog and row order; a
 *  repeated name matches its rows in turn. */
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
        const key = fold(field.name)
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
        const key = fold(columnName(kase, table, row, field))
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
          rows: { kind: 'ids', ids: rows.map(row => kase.id(table, row)) },
        })
    }
  }
  if (!outputs.length)
    throw new Error('No result columns match this case. Open the case that produced this file.')
  return outputs
}
