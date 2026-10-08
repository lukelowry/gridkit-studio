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

import { validateCoverage, validateStatics } from '../shared/coverage.js'
import { type Failure, failureOf } from '../shared/errors.js'
import type { Begin } from '../shared/messages.js'
import { bridge } from './bridge.js'

/** The case's rows, as one stream published them. */
export interface Snapshot {
  readonly rows: Data
  readonly begin: Begin
}

/** Pages of a run's samples, checked against the rows they extend. */
export interface Delivery {
  readonly begin: Extract<Begin, { base: false }>
  readonly samples: readonly SampleBatch[]
}

/** Assemble and validate before publishing. The sender owns retries and terminal errors. */
export function receive(handlers: {
  rows: (snapshot: Snapshot) => void
  pages?: (delivery: Delivery) => void
  /** Whether the view still wants what a stream brings. */
  accept?: (begin: Begin) => boolean
  /** Each stream the view settled, whether it committed it or not. */
  settled?: (stream: number) => void
}): () => void {
  const accept = handlers.accept ?? (() => true)
  let begin: Begin | undefined
  /** The rows held, which pages extend. */
  let base: Snapshot | undefined
  let batches: DataBatch[] = []
  let latest = -1
  let sequence = 0
  let problem: Failure | undefined
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
      let rows: Snapshot | undefined
      let pages: Delivery | undefined
      try {
        if (!accept(complete))
          throw Object.assign(new Error('Stream superseded.'), { code: 'superseded' })
        if (problem) throw Object.assign(new Error(problem.message), problem)
        if (complete.base) {
          const text = JSON.stringify(complete.schema)
          if (schema?.text !== text) schema = { value: complete.schema, text }
          const data = createData(
            schema.value,
            pending.filter((batch): batch is RowBatch => batch.kind === 'rows'),
          )
          validateStatics(data, complete.fields, complete.counts)
          validateCoverage(data, message.coverage)
          rows = Object.freeze({ rows: data, begin: complete })
          base = rows
        } else {
          const held = base?.begin.revision
          if (
            !held ||
            held.uri !== complete.revision.uri ||
            held.version !== complete.revision.version ||
            held.attachmentId !== complete.revision.attachmentId
          )
            throw failure('conflict', 'Pages need the rows they extend.')
          const samples = pending.filter((batch): batch is SampleBatch => batch.kind === 'samples')
          validateCoverage(appendData(base!.rows, samples), message.coverage)
          pages = { begin: complete, samples }
        }
        settled = { kind: 'commit', stream: complete.stream }
      } catch (reason) {
        settled = { kind: 'commit', stream: complete.stream, error: failureOf(reason) }
      }
      // The commit is final before notifying a renderer. A renderer failure cannot turn an
      // accepted stream into a rejected one that the sender might send again.
      try {
        if (rows) handlers.rows(rows)
        if (pages) handlers.pages?.(pages)
      } catch (reason) {
        bridge.report(reason)
      }
      bridge.send(settled)
      handlers.settled?.(complete.stream)
    }
  })
}
