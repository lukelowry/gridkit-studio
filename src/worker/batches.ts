import { blockByteLength, type DataBatch } from '@latkit/model'

/** Coalesce bounded owned batches without losing acknowledgement backpressure. */
export async function* packets(
  source: AsyncIterable<DataBatch>,
  signal: AbortSignal,
  limit: number,
): AsyncGenerator<DataBatch[]> {
  let pending: DataBatch[] = []
  let bytes = 0
  for await (const batch of source) {
    signal.throwIfAborted()
    const size = blockByteLength([batch])
    if (pending.length && bytes + size > limit) {
      yield pending
      pending = []
      bytes = 0
    }
    pending.push(batch)
    bytes += size
    if (bytes >= limit) {
      yield pending
      pending = []
      bytes = 0
    }
  }
  signal.throwIfAborted()
  if (pending.length) yield pending
}
