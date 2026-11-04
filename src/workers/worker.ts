/** The extension's worker: the case files Studio shows, each read once, GridKit's runs, and the
 *  results files Studio reads, each against a case it read. Results keep the case they were read
 *  against, so the views of results read that case as it was, whatever its file reads since. */

import { workerData } from 'node:worker_threads'

import { type Case, catalog as bundled, catalogOf } from '../gridkit/index.js'
import { projectionPage } from '../gridkit/projection.js'
import { superseded } from '../shared/errors.js'
import type { Source, WorkerApi, WorkerOptions } from '../shared/messages.js'
import { caseFiles } from './cases.js'
import { loadNative } from './native.js'
import { summarize } from './parsed.js'
import { resultsFiles } from './results.js'
import { memory, serve } from './serve.js'

const options = workerData as WorkerOptions
await loadNative(options.wasmPath)
const cases = caseFiles(options.catalog === undefined ? bundled : catalogOf(options.catalog))
const results = resultsFiles(options, cases.latest)

/** The case `source` names: a file as it reads now, or the one results were read against. */
const caseFor = (source: Source): Case =>
  'results' in source ? results.fileOf(source.results).kase : cases.latest(source.revision).kase

serve<WorkerApi>(
  {
    ...cases.handlers,
    ...results.handlers,
    async project(input, signal) {
      const kase = caseFor(input)
      const page = await projectionPage(kase.projected(), input.fields, input.cursor, signal)
      if (caseFor(input) !== kase) throw superseded()
      return page
    },
    // The case results were read against, as the file it was read from said then: as it reads now
    // when it reads the same.
    async describe({ results: id }, signal) {
      const { kase, layout } = results.fileOf(id)
      const read = cases.read(layout.revision.uri)
      return read?.kase === kase ? read.summary : summarize(kase, layout.revision, signal)
    },
    stats: async () => ({ memory: memory(), cases: cases.count, ...results.stats() }),
  },
  ['project', 'page', 'frames'],
  // Nobody waits on a run, which the extension holds until it ends, nor on Problems, which fills
  // in once the views have what they wait on.
  ['validate', 'run'],
)

process.once('exit', () => {
  cases.dispose()
  results.dispose()
})
