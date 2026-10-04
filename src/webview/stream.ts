/** Assemble the case a view draws from the streams the extension sends: rows that replace it, and
 *  samples that replace or continue the ones it holds. Each batch is acknowledged as it is taken. */

import {
  appendData,
  createData,
  type Data,
  type DataBatch,
  type RowBatch,
  type SampleBatch,
} from '@latkit/model'

import type { Begin } from '../shared/messages.js'
import { bridge } from './bridge.js'

/** Call `held` each time a stream ends, with the case and the run samples it holds and with the
 *  case alone, whose identity changes only when its rows do; and `failed` when a stream cannot be
 *  assembled. Returns the stop. */
export function receive(
  held: (data: Data, begin: Begin, rows: Data) => void,
  failed: (reason: unknown) => void,
): () => void {
  let begin: Begin | undefined
  /** The rows alone, which samples that replace the held ones start again from. */
  let base: Data | undefined
  let data: Data | undefined
  let batches: DataBatch[] = []
  return bridge.on((message) => {
    if (message.kind === 'begin') {
      begin = message
      batches = []
    } else if (message.kind === 'batch') {
      if (message.stream === begin?.stream) batches.push(...message.batches)
      bridge.send({ kind: 'ack', stream: message.stream, sequence: message.sequence })
    } else if (message.kind === 'end' && message.stream === begin?.stream) {
      try {
        if (begin.base)
          base = createData(
            begin.schema,
            batches.filter((batch): batch is RowBatch => batch.kind === 'rows'),
          )
        if (!base) return
        data = appendData(
          begin.append && data ? data : base,
          batches.filter((batch): batch is SampleBatch => batch.kind === 'samples'),
        )
        batches = []
        held(data, begin, base)
      } catch (reason) {
        failed(reason)
      }
    }
  })
}
