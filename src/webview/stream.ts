/** Assembles the case from the extension's streams, acknowledging each batch on receipt. */

import {
  appendData,
  createData,
  type Data,
  type DataBatch,
  type RowBatch,
  type SampleBatch,
  type Schema,
} from '@latkit/model'

import type { Begin } from '../shared/messages.js'
import { bridge } from './bridge.js'

/** Calls `held` as each stream ends with the case and its samples, and the rows alone, whose
 *  identity changes only when they do; `failed` when a stream cannot be assembled. */
export function receive(
  held: (data: Data, begin: Begin, rows: Data) => void,
  failed: (reason: unknown) => void,
  accept: (begin: Begin) => boolean = () => true,
): () => void {
  let begin: Begin | undefined
  /** The rows alone, which replacing samples start from. */
  let base: Data | undefined
  let data: Data | undefined
  let batches: DataBatch[] = []
  let latest = -1
  /** Reused while its content is unchanged: each stream carries a copy, and the renderers keep
   *  their cached work only for the same schema object. */
  let schema: { readonly value: Schema; readonly text: string } | undefined
  return bridge.on((message) => {
    if (message.kind === 'begin') {
      if (message.stream <= latest) return
      latest = message.stream
      begin = message
      batches = []
    } else if (message.kind === 'batch') {
      if (message.stream === begin?.stream) batches.push(...message.batches)
      bridge.send({ kind: 'ack', stream: message.stream, sequence: message.sequence })
    } else if (message.kind === 'end' && message.stream === begin?.stream) {
      const complete = begin
      begin = undefined
      const pending = batches
      batches = []
      if (!accept(complete)) return
      try {
        let nextBase = base
        let nextSchema = schema
        if (complete.base) {
          const text = JSON.stringify(complete.schema)
          if (nextSchema?.text !== text) nextSchema = { value: complete.schema, text }
          nextBase = createData(
            nextSchema.value,
            pending.filter((batch): batch is RowBatch => batch.kind === 'rows'),
          )
        }
        if (!nextBase) return
        const nextData = appendData(
          complete.append && !complete.base && data ? data : nextBase,
          pending.filter((batch): batch is SampleBatch => batch.kind === 'samples'),
        )
        base = nextBase
        data = nextData
        schema = nextSchema
        held(data, complete, base)
      } catch (reason) {
        failed(reason)
      }
    }
  })
}
