/** The case worker: each open case's source, parsed as the user edits it, and what the views and the
 *  editor read of it. Results files and runs have a worker of their own, so neither slows editing. */

import { diagnoseAsync } from './gridkit/edits.js'
import {
  applyChanges,
  type Case,
  catalog,
  completionsAt,
  presentation,
  sourceContext,
  sourceRange,
  transaction,
} from './gridkit/index.js'
import { anchors } from './gridkit/inspection.js'
import type { Request, Revision, Summary } from './shared/messages.js'
import { CaseCache, summarize } from './worker/cases.js'
import { queried, rowsOf } from './worker/reads.js'
import { serve } from './worker/serve.js'

const cases = new Map<string, { kase: Case; summary: Summary; generation: object }>()
const sources = new CaseCache()
const parses = new Map<string, object>()
const attachments = new Map<string, string | undefined>()
const mirrors = new Map<string, { version: number; text: string }>()

/** The case parsed at `revision`; throws unless it is the latest parse. */
const get = (revision: Revision) => {
  const entry = cases.get(revision.uri)
  if (
    !entry ||
    entry.summary.version !== revision.version ||
    parses.get(revision.uri) !== entry.generation ||
    (revision.attachmentId !== undefined && attachments.get(revision.uri) !== revision.attachmentId)
  )
    throw Object.assign(new Error('The document changed. Wait for the current revision.'), {
      code: 'stale',
    })
  return entry
}

async function dispatch(request: Request, signal: AbortSignal): Promise<unknown> {
  switch (request.method) {
    case 'shutdown':
      return null
    case 'anchors':
      return anchors(get(request.input).kase, request.input, signal)
    case 'parse': {
      const { uri, version, attachmentId } = request.input
      const previous = mirrors.get(uri)
      if (
        !('text' in request.input) &&
        (previous?.version !== request.input.baseVersion || attachments.get(uri) !== attachmentId)
      )
        throw new Error('Source mirror is stale.')
      const text =
        'text' in request.input
          ? request.input.text
          : applyChanges(previous!.text, request.input.changes)
      mirrors.set(uri, { version, text })
      const generation = {}
      parses.set(uri, generation)
      attachments.set(uri, attachmentId)
      const started = performance.now()
      const kase = await sources.parse(text, catalog, uri.split('/').at(-1) ?? 'Case', signal)
      signal.throwIfAborted()
      if (parses.get(uri) !== generation || attachments.get(uri) !== attachmentId)
        throw new Error('Superseded document revision.')
      const summary = summarize(kase, { uri, version, attachmentId }, performance.now() - started)
      cases.set(uri, { kase, summary, generation })
      return summary
    }
    case 'validate': {
      const entry = get(request.input)
      const issues = await diagnoseAsync(entry.kase, signal)
      if (get(request.input) !== entry) throw new Error('Superseded document revision.')
      entry.summary = { ...entry.summary, issues, validation: 'complete' }
      return issues
    }
    case 'query':
      return queried(get(request.input).kase.data, request.input.query, signal)
    case 'rows':
      return rowsOf(get(request.input).kase, request.input.fields, signal)
    case 'complete':
      return completionsAt(catalog, request.input.text, request.input.offset)
    case 'context':
      return sourceContext(get(request.input).kase, request.input.offset)
    case 'symbols': {
      const { kase } = get(request.input)
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
    }
    case 'transact':
      return transaction(get(request.input).kase, request.input.mutations)
    case 'presentation':
      return presentation(get(request.input).kase)
    case 'locate':
      return sourceRange(get(request.input).kase, request.input.id, request.input.field)
    case 'release': {
      const uri = request.input.uri
      if (request.input.attachmentId && attachments.get(uri) !== request.input.attachmentId)
        return null
      cases.delete(uri)
      parses.delete(uri)
      mirrors.delete(uri)
      attachments.delete(uri)
      return null
    }
    case 'stats':
      return {
        memory: {
          heapUsed: process.memoryUsage().heapUsed,
          arrayBuffers: process.memoryUsage().arrayBuffers,
        },
        cacheBytes: 0,
        sessions: cases.size,
        results: 0,
      }
    default:
      throw new Error(`The case worker does not answer ${request.method}.`)
  }
}

serve(dispatch, new Set(['query', 'rows']))
