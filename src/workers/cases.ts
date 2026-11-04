/** The case worker: each case file Studio shows, read whole from disk, and what the views and the
 *  extension read of it. A file changed on disk is read again whole; one written again as it was
 *  keeps its case. Results files and runs have a worker of their own. */

import { fileURLToPath } from 'node:url'
import { workerData } from 'node:worker_threads'

import type { ProjectedDocument } from '../gridkit/document.js'
import {
  type Case,
  catalog as bundled,
  catalogOf,
  diagnose,
  rangeIn,
  sourceRange,
} from '../gridkit/index.js'
import { anchors } from '../gridkit/inspection.js'
import { CaseQueries, projectionPage } from '../gridkit/projection.js'
import { same, type Stamp, stampAt } from '../results/stamp.js'
import { problem, superseded } from '../shared/errors.js'
import type { CaseApi, Revision, Summary, WorkerOptions } from '../shared/messages.js'
import { loadNative } from './native.js'
import { nameOf, readCase, Recent, summarize } from './parsed.js'
import { memory, serve } from './serve.js'

/** A file as last read: its case, what the extension was told of it, and the stamp of the file it
 *  was read from. */
interface Read {
  readonly kase: Case
  readonly summary: Summary
  stamp: Stamp
  queries?: CaseQueries
  projection?: ProjectedDocument
}

await loadNative((workerData as WorkerOptions).wasmPath)

const chosen = (workerData as WorkerOptions | null)?.catalog
const catalog = chosen === undefined ? bundled : catalogOf(chosen)
/** Each file the extension follows: as last read, and the read of it under way, which a newer
 *  read takes the place of. */
const files = new Map<string, { read?: Read; reading?: object }>()
/** Files let go of, kept a while, so one opened again as it was reads nothing. */
const recent = new Recent<Read>()

/** The case read at `revision`; superseded once the file reads otherwise. */
function latest({ uri, version }: Revision): Read {
  const read = files.get(uri)?.read
  if (read?.summary.version !== version) throw superseded()
  return read
}

serve<CaseApi>(
  {
    async read({ uri, version }, signal) {
      let file = files.get(uri)
      if (!file) files.set(uri, (file = { read: recent.take(uri) }))
      const reading = (file.reading = {})
      const current = () => {
        signal.throwIfAborted()
        if (files.get(uri) !== file || file.reading !== reading) throw superseded()
      }
      // Stamped before it is read, so a file that changes meanwhile reads again next time.
      const stamp = await stampAt(fileURLToPath(uri))
      if (!stamp) throw problem('invalid-input', `${nameOf(uri)} is not there.`)
      const before = file.read
      if (before && same(before.stamp, stamp)) return before.summary
      const kase = await readCase(uri, catalog, signal)
      current()
      // Written again as it was, as by a save that changed nothing: the case read stands.
      if (before?.kase.version === kase.version) {
        before.stamp = stamp
        return before.summary
      }
      const summary = await summarize(kase, { uri, version }, signal)
      current()
      before?.queries?.destroy()
      file.read = { kase, summary, stamp }
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
    anchors: async (input, signal) => anchors(latest(input).kase, input, signal),
    locate: async (input) => {
      const { kase } = latest(input)
      return rangeIn(kase.file, sourceRange(kase, input, input.field))
    },
    async project(input, signal) {
      const read = latest(input)
      const document = (read.projection ??= read.kase.projected())
      const page = await projectionPage(document, input.fields, input.cursor, signal)
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
    stats: async () => ({ memory: memory(), cases: files.size }),
  },
  ['project', 'page'],
)

process.once('exit', () => {
  for (const file of files.values()) file.read?.queries?.destroy()
})
