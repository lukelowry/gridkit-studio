/** The case worker: each open case's source, parsed as the user edits it, and what the views and the
 *  editor read of it. Results files and runs have a worker of their own, so neither slows editing. */

import { Case } from '../gridkit/case.js'
import { diagnoseAsync } from '../gridkit/edits.js'
import {
  applyChanges,
  catalog,
  completionsAt,
  presentation,
  sourceContext,
  sourceRange,
  transaction,
} from '../gridkit/index.js'
import { anchors } from '../gridkit/inspection.js'
import type { CaseApi, Revision, SourceDelta, Summary } from '../shared/messages.js'
import { summarize, TextCases } from './parsed.js'
import { queried, rowsOf } from './reads.js'
import { serve } from './serve.js'

/** An open case: its source as last sent, the parse under way, and the case that parse read. */
interface Document {
  attachmentId?: string
  /** The source as last sent, which edits apply to. */
  source: { version: number; text: string }
  /** The latest parse begun: one that ends after another began is let go. */
  parsing: object
  /** The case read, and the text it was read from. */
  read?: { kase: Case; summary: Summary; text: string }
}

const documents = new Map<string, Document>()
/** Cases read from whole texts, found again when a document opens again. */
const opened = new TextCases()
const nameOf = (uri: string) => uri.split('/').at(-1) ?? 'Case'

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

/** The text of `input`'s revision: sent whole, or its changes applied to the source the worker holds,
 *  which must be at their base. */
function sourceOf(input: Revision & SourceDelta): string {
  if ('text' in input) return input.text
  const known = documents.get(input.uri)
  if (known?.source.version !== input.baseVersion || known.attachmentId !== input.attachmentId)
    throw new Error('Source mirror is stale.')
  return applyChanges(known.source.text, input.changes)
}

serve<CaseApi>(
  {
    async parse(input, signal) {
      const { uri, version, attachmentId } = input
      const known = documents.get(uri)
      const text = sourceOf(input)
      const parsing = {}
      documents.set(uri, { attachmentId, source: { version, text }, parsing })
      const started = performance.now()
      const name = nameOf(uri)
      // The same text again, as when the extension sends it whole once more, is the case read. A
      // whole text read before, as when a document opens again, is found by its hash; an edit is
      // never hashed.
      const reread = known?.read?.text === text
      const key = 'text' in input && !reread ? TextCases.key(text, catalog, name) : undefined
      const kase = reread
        ? known!.read!.kase
        : ((key === undefined ? undefined : opened.find(key)) ??
          (await Case.parse(text, catalog, name, signal)))
      if (key) opened.keep(kase, () => key)
      signal.throwIfAborted()
      const document = documents.get(uri)
      if (document?.parsing !== parsing) throw new Error('Superseded document revision.')
      const summary = summarize(kase, { uri, version, attachmentId }, performance.now() - started)
      document.read = { kase, summary, text }
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
    // Completion brings the source up to the revision typed, and reads it up to the cursor alone.
    async complete(input) {
      const text = sourceOf(input)
      const known = documents.get(input.uri)
      const source = { version: input.version, text }
      if (known && known.attachmentId === input.attachmentId) known.source = source
      else documents.set(input.uri, { attachmentId: input.attachmentId, source, parsing: {} })
      return completionsAt(catalog, text, input.offset)
    },
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
      const document = documents.get(uri)
      if (attachmentId && document?.attachmentId !== attachmentId) return null
      // A document let go of stays read, so opening it again parses nothing.
      const read = document?.read
      if (read) opened.keep(read.kase, () => TextCases.key(read.text, catalog, nameOf(uri)))
      documents.delete(uri)
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
