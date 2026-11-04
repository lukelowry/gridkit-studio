/** The worker's case files: each case file Studio shows, read whole from disk, and what the views
 *  and the extension read of it. A file changed on disk is read again whole; one written again as
 *  it was keeps its case. */

import { fileURLToPath } from 'node:url'

import type { Catalog } from '../gridkit/definition.js'
import { type Case, diagnose, rangeIn, sourceRange } from '../gridkit/index.js'
import { networkSelectionOf } from '../gridkit/inspection.js'
import { CaseQueries } from '../gridkit/projection.js'
import { same, settled, type Stamp, stampAt } from '../results/stamp.js'
import { problem, superseded } from '../shared/errors.js'
import type { Revision, Summary, WorkerApi } from '../shared/messages.js'
import type { Handlers } from '../shared/rpc.js'
import { nameOf, readCase, Recent, summarize } from './parsed.js'

/** A file as last read: its case, what the extension was told of it, the stamp of the file it was
 *  read from, once the file had rested before it, and the queries of its tables, once asked. */
export interface Read {
  readonly kase: Case
  readonly summary: Summary
  stamp?: Stamp
  queries?: CaseQueries
}

/** The case files the extension follows, each read with `catalog`. */
export function caseFiles(catalog: Catalog) {
  /** Each file followed: as last read, and the read of it under way, which a newer read takes the
   *  place of. */
  const files = new Map<string, { read?: Read; reading?: object }>()
  /** Files let go of, kept a while, so one opened again as it was reads nothing. */
  const recent = new Recent<Read>()

  /** The case read at `revision`; superseded once the file reads otherwise. */
  function latest({ uri, version }: Revision): Read {
    const read = files.get(uri)?.read
    if (read?.summary.version !== version) throw superseded()
    return read
  }

  const handlers: Pick<
    Handlers<WorkerApi>,
    'read' | 'validate' | 'networkSelection' | 'locate' | 'page' | 'release'
  > = {
    async read({ uri, version }, signal) {
      let file = files.get(uri)
      if (!file) files.set(uri, (file = { read: recent.take(uri) }))
      const reading = (file.reading = {})
      const current = () => {
        signal.throwIfAborted()
        if (files.get(uri) !== file || file.reading !== reading) throw superseded()
      }
      // Stamped before it is read, so a file that changes meanwhile reads again next time.
      const at = BigInt(Date.now()) * 1_000_000n
      const stamp = await stampAt(fileURLToPath(uri))
      if (!stamp) throw problem('invalid-input', `${nameOf(uri)} is not there.`)
      const before = file.read
      if (before && same(before.stamp, stamp)) return before.summary
      // A file that changed just before may change again and keep its stamp: it reads again
      // each time until it rests.
      const kept = settled(stamp, at) ? stamp : undefined
      const kase = await readCase(uri, catalog, signal)
      current()
      // Written again as it was, as by a save that changed nothing: the case read stands.
      if (before?.kase.version === kase.version) {
        before.stamp = kept
        return before.summary
      }
      const summary = await summarize(kase, { uri, version }, signal)
      current()
      before?.queries?.destroy()
      file.read = { kase, summary, stamp: kept }
      return summary
    },
    async validate(revision, signal) {
      const read = latest(revision)
      const found = await diagnose(read.kase, signal)
      if (latest(revision) !== read) throw superseded()
      return found.map(({ offset, length, ...issue }) => ({
        ...issue,
        ...rangeIn(read.kase.file, { offset, length }),
      }))
    },
    networkSelection: async (input, signal) =>
      networkSelectionOf(latest(input).kase, input.entity, signal),
    locate: async (input) => {
      const { kase } = latest(input)
      return rangeIn(kase.file, sourceRange(kase, input, input.field))
    },
    async page({ revision, request }, signal) {
      const read = latest(revision)
      const queries = (read.queries ??= new CaseQueries(read.kase.projected()))
      const page = await queries.page(request, signal)
      if (latest(revision) !== read) throw superseded()
      return page
    },
    async release({ uri }) {
      const read = files.get(uri)?.read
      files.delete(uri)
      // A file let go of stays read a while, so opening it again as it was reads nothing.
      if (read) {
        read.queries?.destroy()
        read.queries = undefined
        recent.keep(uri, read)
      }
      return null
    },
  }

  return {
    latest,
    handlers,
    /** The file at `uri` as last read, while it is followed. */
    read: (uri: string): Read | undefined => files.get(uri)?.read,
    /** How many files it follows. */
    get count() {
      return files.size
    },
    /** Lets go of every table's queries, as the worker ends. */
    dispose() {
      for (const file of files.values()) file.read?.queries?.destroy()
    },
  }
}
