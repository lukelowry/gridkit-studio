/** The worker's case files, read whole from disk. A file rewritten unchanged keeps its case. */

import { versionOf } from '../gridkit/case.js'
import type { Catalog } from '../gridkit/definition.js'
import { type Case, diagnose, rangeIn, sourceRange } from '../gridkit/index.js'
import { networkSelectionOf } from '../gridkit/inspection.js'
import { CaseQueries } from '../gridkit/rows.js'
import { fileURLToPath, nameOf } from '../platform/path.js'
import { same, settled, type Stamp, stampAt } from '../results/stamp.js'
import { problem, superseded } from '../shared/errors.js'
import type { Revision, Summary, WorkerApi } from '../shared/messages.js'
import type { Handlers } from '../shared/rpc.js'
import { caseBytes, parseCase, summarize } from './parsed.js'

/** A file as last read. `stamp` is set only when the file had settled. */
export interface CaseRead {
  readonly kase: Case
  readonly summary: Summary
  stamp?: Stamp
  queries?: CaseQueries
}

export function caseFiles(catalog: Catalog) {
  /** Each followed file's last read, and a token for the read in progress. */
  const files = new Map<string, { read?: CaseRead; reading?: object }>()

  /** The read at `revision`. Throws `superseded` once the file has changed. */
  function latest({ uri, version }: Revision): CaseRead {
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
      if (!file) files.set(uri, (file = {}))
      const reading = (file.reading = {})
      const current = () => {
        signal.throwIfAborted()
        if (files.get(uri) !== file || file.reading !== reading) throw superseded()
      }
      // Stamp before reading, so a change during the read causes another read next time.
      const at = BigInt(Date.now()) * 1_000_000n
      const stamp = await stampAt(fileURLToPath(uri))
      if (!stamp) throw problem('invalid-input', `${nameOf(uri)} is not there.`)
      const before = file.read
      if (before && same(before.stamp, stamp)) return before.summary
      // A file changed very recently could change again without a new stamp, so it is read again
      // each time until it settles.
      const kept = settled(stamp, at) ? stamp : undefined
      const bytes = await caseBytes(uri, signal)
      current()
      // A file rewritten unchanged keeps its case, found by fingerprint before parsing.
      const fingerprint = await versionOf(catalog, bytes)
      current()
      if (before?.kase.version === fingerprint) {
        before.stamp = kept
        return before.summary
      }
      const kase = await parseCase(bytes, uri, catalog, fingerprint, signal)
      current()
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
      const queries = (read.queries ??= new CaseQueries(read.kase.columns()))
      const page = await queries.page(request, signal)
      if (latest(revision) !== read) throw superseded()
      return page
    },
    async release({ uri }) {
      files.get(uri)?.read?.queries?.destroy()
      files.delete(uri)
      return null
    },
  }

  return {
    latest,
    handlers,
    read: (uri: string): CaseRead | undefined => files.get(uri)?.read,
    get count() {
      return files.size
    },
    dispose() {
      for (const file of files.values()) file.read?.queries?.destroy()
    },
  }
}
