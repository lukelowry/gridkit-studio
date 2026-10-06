/** Assembles the case from the extension's streams, acknowledging each batch on receipt. */

import {
  appendData,
  createData,
  type Data,
  type DataBatch,
  failure,
  type RowBatch,
  type SampleBatch,
  type Schema,
} from '@latkit/model'

import { type Failure, failureOf } from '../shared/errors.js'
import type { Begin } from '../shared/messages.js'
import { bridge } from './bridge.js'

/** Assemble and validate before publishing. The sender owns retries and terminal errors. */
export function receive(
  held: (data: Data, begin: Begin, rows: Data) => void,
  accept: (begin: Begin) => boolean = () => true,
): () => void {
  let begin: Begin | undefined
  /** The rows alone, which replacing samples start from. */
  let base: Data | undefined
  let data: Data | undefined
  let batches: DataBatch[] = []
  let latest = -1
  let sequence = 0
  let problem: Failure | undefined
  let committed: Begin | undefined
  let settled: { kind: 'commit'; stream: number; error?: Failure } | undefined
  /** Reused while its content is unchanged: each stream carries a copy, and the renderers keep
   *  their cached work only for the same schema object. */
  let schema: { readonly value: Schema; readonly text: string } | undefined
  return bridge.on((message) => {
    if (message.kind === 'begin') {
      if (message.stream <= latest) return
      latest = message.stream
      begin = message
      batches = []
      sequence = 0
      problem = undefined
    } else if (message.kind === 'batch') {
      if (message.stream === begin?.stream && !problem) {
        if (message.sequence !== sequence + 1)
          problem = failureOf(failure('protocol', 'Stream batch sequence is incomplete.'))
        else {
          batches.push(...message.batches)
          sequence = message.sequence
        }
      }
      bridge.send({ kind: 'ack', stream: message.stream, sequence: message.sequence })
    } else if (message.kind === 'end' && message.stream === settled?.stream) {
      bridge.send(settled)
    } else if (message.kind === 'end' && message.stream === begin?.stream) {
      const complete = begin
      begin = undefined
      const pending = batches
      batches = []
      try {
        if (!accept(complete))
          throw Object.assign(new Error('Stream superseded.'), { code: 'superseded' })
        if (problem) throw Object.assign(new Error(problem.message), problem)
        if (
          !complete.base &&
          (!committed ||
            committed.revision.uri !== complete.revision.uri ||
            committed.revision.version !== complete.revision.version ||
            committed.revision.attachmentId !== complete.revision.attachmentId ||
            (complete.append && committed.simulationId !== complete.simulationId))
        )
          throw failure('conflict', 'Stream requires a new base snapshot.')
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
        if (!nextBase) throw failure('conflict', 'Stream has no base snapshot.')
        const nextData = appendData(
          complete.append && !complete.base && data ? data : nextBase,
          pending.filter((batch): batch is SampleBatch => batch.kind === 'samples'),
        )
        held(nextData, complete, nextBase)
        base = nextBase
        data = nextData
        schema = nextSchema
        committed = complete
        settled = { kind: 'commit', stream: complete.stream }
      } catch (reason) {
        settled = { kind: 'commit', stream: complete.stream, error: failureOf(reason) }
      }
      bridge.send(settled)
    }
  })
}
