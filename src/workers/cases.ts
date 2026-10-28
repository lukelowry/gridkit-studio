/** The case worker: each open case's source, parsed as the user edits it, and what the views and the
 *  editor read of it. Results files and runs have a worker of their own, so neither slows editing. */

import { workerData } from 'node:worker_threads'

import { Case } from '../gridkit/case.js'
import { deltaProjectionPage } from '../gridkit/deltas.js'
import type { ProjectedDocument } from '../gridkit/document.js'
import { diagnose } from '../gridkit/edits.js'
import {
  applyChanges,
  catalog as bundled,
  catalogOf,
  completionsAt,
  delivered,
  outline,
  sourceContext,
  sourceRange,
  transaction,
  unchangedBy,
} from '../gridkit/index.js'
import { anchors } from '../gridkit/inspection.js'
import { CaseQueries, projectionPage } from '../gridkit/projection.js'
import { detail, problem, superseded } from '../shared/errors.js'
import type { CaseApi, Revision, SourceDelta, Summary, WorkerOptions } from '../shared/messages.js'
import { loadNative } from './native.js'
import { nameOf, summarize, TextCases } from './parsed.js'
import { memory, send, serve } from './serve.js'

/** An open case: its source as last sent, the parse under way, and the case that parse read. */
interface Document {
  attachmentId?: string
  /** The source as last sent, which edits apply to. */
  source: { version: number; text: string }
  /** The latest parse begun: one that ends after another began is let go. */
  parsing: object
  /** The case read, and the text it was read from. */
  read?: {
    kase: Case
    summary: Summary
    text: string
    queries?: CaseQueries
    projection?: ProjectedDocument
    previous?: Case
  }
}

await loadNative((workerData as WorkerOptions).wasmPath)

const chosen = (workerData as WorkerOptions | null)?.catalog
const catalog = chosen === undefined ? bundled : catalogOf(chosen)
const documents = new Map<string, Document>()
/** Cases read from whole texts, found again when a document opens again. */
const opened = new TextCases()

/** The case read at `revision`; stale once a newer revision is on its way. */
function latest({ uri, version, attachmentId }: Revision) {
  const document = documents.get(uri)
  const read = document?.read
  if (
    !read ||
    read.summary.version !== version ||
    document.source.version !== version ||
    (attachmentId !== undefined && document.attachmentId !== attachmentId)
  )
    throw superseded()
  return read
}

/** Why the worker's copy of a document cannot take the changes it was sent: the extension sends the
 *  whole text instead. */
const stale = () => problem('stale-source', 'Source mirror is stale.')

/** The text of `input`'s revision: sent whole, or its changes applied to the source the worker holds,
 *  which must be at their base and make a text of the length the extension's has. */
function sourceOf(input: Revision & SourceDelta): string {
  if ('text' in input) return input.text
  const known = documents.get(input.uri)
  if (known?.source.version !== input.baseVersion || known.attachmentId !== input.attachmentId)
    throw stale()
  const text = applyChanges(known.source.text, input.changes)
  if (text.length !== input.length) throw stale()
  return text
}

serve<CaseApi>(
  {
    async parse(input, signal) {
      const { uri, version, attachmentId } = input
      const known = documents.get(uri)
      const text = sourceOf(input)
      const parsing = {}
      // The last case read of this document answers for its own revision until this one reads.
      const read = known && known.attachmentId === attachmentId ? known.read : undefined
      documents.set(uri, { attachmentId, source: { version, text }, parsing, read })
      const started = performance.now()
      const name = nameOf(uri)
      // The same text again, as when the extension sends it whole once more, is the case read. A
      // document opened, whose whole text may have been read before, is found by its hash, unless
      // it is too large to keep; an edit, or the whole text sent again, is never hashed.
      const reread = read?.text === text
      const key =
        'text' in input && !known && !reread && opened.fits(text)
          ? TextCases.key(text, catalog, name)
          : undefined
      // An edit of a case read before reads again only the records it changed: when its changes are
      // of the text that case was read from, what they leave of it is known without a comparison.
      const unchanged =
        'changes' in input && read?.text === known?.source.text
          ? unchangedBy(read!.text.length, input.changes)
          : undefined
      const kase = reread
        ? read!.kase
        : ((key === undefined ? undefined : opened.find(key)) ??
          (read
            ? await Case.revise(read.kase, text, {
                name,
                signal,
                // A defect in reading the edit alone is said in the log; the case reads whole.
                defects: (error) => send({ kind: 'log', level: 'error', message: detail(error) }),
                ...(unchanged && { unchanged }),
              })
            : await Case.parse(text, catalog, name, signal)))
      if (key) opened.keep(kase, () => key)
      signal.throwIfAborted()
      const document = documents.get(uri)
      if (document?.parsing !== parsing) throw superseded()
      const summary = await summarize(
        kase,
        { uri, version, attachmentId },
        { parseMs: performance.now() - started, signal },
      )
      // A parse begun meanwhile replaced the document this one began with.
      if (documents.get(uri) !== document) throw superseded()
      document.read?.queries?.destroy()
      document.read = { kase, summary, text, ...(read && { previous: read.kase }) }
      return summary
    },
    async validate(revision, signal) {
      const read = latest(revision)
      const issues = await diagnose(read.kase, signal)
      if (latest(revision) !== read) throw superseded()
      read.summary = { ...read.summary, issues, validation: 'complete' }
      return issues
    },
    anchors: async (input, signal) => anchors(latest(input).kase, input, signal),
    // Completion reads the revision typed up to the cursor alone, and leaves the copy the worker
    // holds as it was: a parse brings that up to date, and only a release lets go of it.
    // The case last read of the same document finds the record the cursor is in, which alone is
    // read.
    complete: async (input) => {
      const document = documents.get(input.uri)
      const read = document?.attachmentId === input.attachmentId ? document?.read : undefined
      return completionsAt(catalog, sourceOf(input), input.offset, read)
    },
    context: async (input) => sourceContext(latest(input).kase, input.offset),
    symbols: async ({ limit, ...revision }, signal) =>
      outline(latest(revision).kase, signal, limit),
    locate: async (input) => sourceRange(latest(input).kase, input, input.field),
    // As VS Code takes them in least time, from the text they are of.
    transact: async (input) => {
      if (documents.get(input.uri)?.source.version !== input.version) throw superseded()
      const { kase, text } = latest(input)
      return delivered(text, transaction(kase, input.mutations))
    },
    async project(input, signal) {
      const read = latest(input)
      const document = (read.projection ??= read.kase.projected())
      const page =
        input.base && read.previous
          ? await deltaProjectionPage(
              read.previous,
              read.kase,
              input.fields,
              input.base,
              input.cursor,
              signal,
            )
          : await projectionPage(document, input.fields, input.cursor, signal)
      if (latest(input) !== read) throw superseded()
      return page
    },
    async page(input, signal) {
      const read = latest(input)
      const queries = (read.queries ??= new CaseQueries(
        (read.projection ??= read.kase.projected()),
      ))
      const page = await queries.page(input.request, signal)
      if (latest(input) !== read) throw superseded()
      return page
    },
    async release({ uri, attachmentId }) {
      const document = documents.get(uri)
      if (attachmentId && document?.attachmentId !== attachmentId) return null
      // A document let go of stays read, so opening it again parses nothing.
      const read = document?.read
      read?.queries?.destroy()
      if (read) opened.keep(read.kase, () => TextCases.key(read.text, catalog, nameOf(uri)))
      documents.delete(uri)
      return null
    },
    stats: async () => ({ memory: memory(), cases: documents.size }),
  },
  ['project', 'page'],
)

process.once('exit', () => {
  for (const document of documents.values()) document.read?.queries?.destroy()
})
