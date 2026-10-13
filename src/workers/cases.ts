/** The case worker: each open case's source, parsed as the user edits it, and what the views and the
 *  editor read of it. Results files and runs have a worker of their own, so neither slows editing. */

import { Case } from '../gridkit/case.js'
import { diagnose } from '../gridkit/edits.js'
import {
  applyChanges,
  catalog,
  completionsAt,
  outline,
  presentation,
  sourceContext,
  sourceRange,
  transaction,
} from '../gridkit/index.js'
import { anchors } from '../gridkit/inspection.js'
import { detail, problem, superseded } from '../shared/errors.js'
import type { CaseApi, Revision, SourceDelta, Summary } from '../shared/messages.js'
import { nameOf, summarize, TextCases } from './parsed.js'
import { queried, rowsOf } from './reads.js'
import { memory, send, serve } from './serve.js'

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

/** The case read at `revision`; stale once a newer revision is on its way. */
function latest({ uri, version, attachmentId }: Revision) {
  const document = documents.get(uri)
  const read = document?.read
  if (
    !read ||
    read.summary.version !== version ||
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
      // An edit of a case read before reads again only the records it changed.
      const kase = reread
        ? read!.kase
        : ((key === undefined ? undefined : opened.find(key)) ??
          (read
            ? await Case.revise(read.kase, text, name, signal, (error) =>
                // A defect in reading the edit alone is said in the log; the case reads whole.
                send({ kind: 'log', level: 'error', message: detail(error) }),
              )
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
      document.read = { kase, summary, text }
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
    locate: async (input) => sourceRange(latest(input).kase, input.id, input.field),
    transact: async (input) => transaction(latest(input).kase, input.mutations),
    presentation: (revision, signal) => presentation(latest(revision).kase, signal),
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
    stats: async () => ({ memory: memory(), cases: documents.size }),
  },
  ['query', 'rows'],
)
