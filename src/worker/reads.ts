/** What both workers read of a case: a query's blocks, and the static fields a view draws. */

import {
  type Data,
  type FieldSelection,
  type Query,
  type QueryBlock,
  read,
  type RowBatch,
  selectBatches,
} from '@latkit/model'

import type { Case } from '../gridkit/index.js'

const BLOCK_BYTES = 256 << 10

/** `query` of `data`, in blocks of their own, to send. */
export async function queried(data: Data, query: Query, signal: AbortSignal) {
  const blocks: QueryBlock[] = []
  for await (const block of read(data, query, {
    signal,
    maxBlockBytes: BLOCK_BYTES,
    buffers: 'owned',
  }))
    blocks.push(block)
  return blocks
}

/** `fields` of `kase`'s rows, with their ids, in batches of their own, to send. A field the case
 *  samples comes with a results file, never with the rows. */
export async function rowsOf(kase: Case, fields: readonly FieldSelection[], signal: AbortSignal) {
  const statics = fields
    .map((field) => ({
      ...field,
      select: field.select.filter((name) => !kase.schema.types[field.from]!.fields[name]!.sampled),
    }))
    .filter((field) => field.select.length > 0)
  const batches: RowBatch[] = []
  for await (const batch of selectBatches(kase.data, statics, {
    signal,
    maxBlockBytes: BLOCK_BYTES,
    buffers: 'owned',
  }))
    if (batch.kind === 'rows') batches.push(batch)
  return batches
}
