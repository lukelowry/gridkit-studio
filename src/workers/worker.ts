/** The extension's worker. Results keep the case they were read against, even after it changes. */

import { type Case, catalog as bundled, catalogOf } from '../gridkit/index.js'
import { caseRowsPage } from '../gridkit/rows.js'
import { onExit } from '../platform/host.js'
import { workerData } from '../platform/worker.js'
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

const caseFor = (source: Source): Case =>
  'results' in source ? results.fileOf(source.results).kase : cases.latest(source.revision).kase

serve<WorkerApi>(
  {
    ...cases.handlers,
    ...results.handlers,
    async caseRows(input, signal) {
      const kase = caseFor(input)
      const page = await caseRowsPage(kase.columns(), input.fields, input.cursor, signal)
      if (caseFor(input) !== kase) throw superseded()
      return page
    },
    // The current summary is reused when the file still has the results' case.
    async describe({ results: id }, signal) {
      const { kase, layout } = results.fileOf(id)
      const read = cases.read(layout.revision.uri)
      return read?.kase === kase ? read.summary : summarize(kase, layout.revision, signal)
    },
    stats: async () => ({ memory: memory(), cases: cases.count, ...results.stats() }),
  },
  ['caseRows', 'page', 'frames', 'tile'],
  // Runs last until they end, and Problems fills in after the views, so neither is foreground
  // work.
  ['validate', 'run'],
)

onExit(() => cases.dispose())
