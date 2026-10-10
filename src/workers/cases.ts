/** The case worker: each open case's source, parsed as the user edits it, and what the views and the
 *  editor read of it. Results files and runs have a worker of their own, so neither slows editing. */

import { diagnoseAsync } from '../gridkit/edits.js'
import {
  applyChanges,
  type Case,
  catalog,
  completionsAt,
  presentation,
  sourceContext,
  sourceRange,
  transaction,
} from '../gridkit/index.js'
import { anchors } from '../gridkit/inspection.js'
import type { CaseApi, Revision, Summary } from '../shared/messages.js'
import { CaseCache, summarize } from './parsed.js'
import { queried, rowsOf } from './reads.js'
import { serve } from './serve.js'

/** An open case: its source as last sent, the parse under way, and the case that parse read. */
interface Document {
  attachmentId?: string
  /** The source as last sent, which edits apply to. */
  source: { version: number; text: string }
  /** The latest parse begun: one that ends after another began is let go. */
  parsing: object
  read?: { kase: Case; summary: Summary }
}

const documents = new Map<string, Document>()
const sources = new CaseCache()

/** The case read at `revision`; stale once a newer revision is on its way. */
function latest({ uri, version, attachmentId }: Revision) {
  const document = documents.get(uri)
  const read = document?.read
  if (
    !read ||
    read.summary.version !== version ||
    (attachmentId !== undefined && document.attachmentId !== attachmentId)
  )
    throw Object.assign(new Error('The document changed. Wait for the current revision.'), {
      code: 'stale',
    })
  return read
}

serve<CaseApi>(
  {
    async parse(input, signal) {
      const { uri, version, attachmentId } = input
      const known = documents.get(uri)
      if (
        !('text' in input) &&
        (known?.source.version !== input.baseVersion || known.attachmentId !== attachmentId)
      )
        throw new Error('Source mirror is stale.')
      const text = 'text' in input ? input.text : applyChanges(known!.source.text, input.changes)
      const parsing = {}
      documents.set(uri, { attachmentId, source: { version, text }, parsing })
      const started = performance.now()
      const kase = await sources.parse(text, catalog, uri.split('/').at(-1) ?? 'Case', signal)
      signal.throwIfAborted()
      const document = documents.get(uri)
      if (document?.parsing !== parsing) throw new Error('Superseded document revision.')
      const summary = summarize(kase, { uri, version, attachmentId }, performance.now() - started)
      document.read = { kase, summary }
      return summary
    },
    async validate(revision, signal) {
      const read = latest(revision)
      const issues = await diagnoseAsync(read.kase, signal)
      if (latest(revision) !== read) throw new Error('Superseded document revision.')
      read.summary = { ...read.summary, issues, validation: 'complete' }
      return issues
    },
    anchors: async (input, signal) => anchors(latest(input).kase, input, signal),
    complete: async ({ text, offset }) => completionsAt(catalog, text, offset),
    context: async (input) => sourceContext(latest(input).kase, input.offset),
    async symbols(revision, signal) {
      const { kase } = latest(revision)
      const symbols = []
      for (const table of kase.tables.values())
        for (let row = 0; row < table.records.length && symbols.length < 10000; row++) {
          signal.throwIfAborted()
          const id = kase.id(table, row)
          symbols.push({
            ...sourceRange(kase, id),
            name: id,
            detail: table.shape.definition.label ?? table.shape.type,
          })
        }
      return symbols
    },
    locate: async (input) => sourceRange(latest(input).kase, input.id, input.field),
    transact: async (input) => transaction(latest(input).kase, input.mutations),
    presentation: async (revision) => presentation(latest(revision).kase),
    query: ({ query, ...revision }, signal) => queried(latest(revision).kase.data, query, signal),
    rows: ({ fields, ...revision }, signal) => rowsOf(latest(revision).kase, fields, signal),
    async release({ uri, attachmentId }) {
      if (!attachmentId || documents.get(uri)?.attachmentId === attachmentId) documents.delete(uri)
      return null
    },
    stats: async () => ({
      memory: {
        heapUsed: process.memoryUsage().heapUsed,
        arrayBuffers: process.memoryUsage().arrayBuffers,
      },
      cases: documents.size,
    }),
  },
  ['query', 'rows'],
)
