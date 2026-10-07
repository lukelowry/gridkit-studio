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

/** Sends each packet of `source` once the one before it is acknowledged, and prepares the next
 *  meanwhile: one packet waits on its acknowledgement while one more is made ready. */
export async function sendAhead<T>(source: AsyncIterable<T>, send: (packet: T) => Promise<void>) {
  let sent = Promise.resolve()
  for await (const packet of source) {
    await sent
    sent = send(packet)
    // It is awaited before the next send or after the last; a failure meanwhile waits for that.
    sent.catch(() => {})
  }
  await sent
}
