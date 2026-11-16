/** The worker's GridKit runs and results files. Several results ids may share one file, idle files
 *  stay cached, and committed stores outlive the worker. */

import { type Case, simulate, sweepOrphans } from '../gridkit/index.js'
import { solverLine } from '../gridkit/solver.js'
import { stat } from '../platform/files.js'
import { basename } from '../platform/path.js'
import { closed, PROGRESS_MS, ResultCache, ResultsFile, stampOf, Stores } from '../results/index.js'
import { defect, detail, failedWith, message, quiet } from '../shared/errors.js'
import type {
  Results,
  ResultsLayout,
  Revision,
  Run,
  WorkerApi,
  WorkerOptions,
} from '../shared/messages.js'
import type { Handlers } from '../shared/rpc.js'
import { send } from './serve.js'

/** Run output logged per LOG_MS, besides errors. The rest are only counted. */
const LOG_LINES = 100
const LOG_CHARS = 64 << 10
const LOG_MS = 1000

export function resultsFiles(
  options: WorkerOptions,
  latest: (revision: Revision) => { readonly kase: Case },
) {
  const cache = new ResultCache(options.cacheBytes)
  const stores = new Stores(options.store)
  // A failed sweep surfaces in the next create or find.
  stores.sweep(options.saved).catch(() => {})
  if (options.runs) void sweepOrphans(options.runs)

  const resultsById = new Map<string, ResultsFile>()
  /** Every loaded results file, open or idle. */
  const files = new Set<ResultsFile>()
  const sentLayouts = new Map<string, ResultsLayout>()
  let runs = 0

  function fileOf(id: string): ResultsFile {
    const file = resultsById.get(id)
    if (!file) throw closed()
    return file
  }

  /** Runs `read` on the file of results `id`. A `results-lost` error drops the file. */
  async function using<R>(
    id: string,
    signal: AbortSignal,
    read: (file: ResultsFile, signal: AbortSignal) => Promise<R>,
  ): Promise<R> {
    const file = fileOf(id)
    try {
      return await file.use(signal, (s) => read(file, s))
    } catch (error) {
      if (failedWith(error, 'results-lost')) await lose(file)
      throw error
    }
  }

  /** Drops `file` and its damaged store, and tells the extension so it reopens them by path. */
  async function lose(file: ResultsFile): Promise<void> {
    if (!files.has(file)) return
    for (const [id, bound] of resultsById) {
      if (bound !== file) continue
      resultsById.delete(id)
      sentLayouts.delete(id)
      send({ kind: 'lost', uri: file.layout.revision.uri, results: id })
    }
    await retire(file, true)
  }

  const resultsOf = (id: string, file: ResultsFile): Results => ({
    ...file.layout,
    ...file.progress,
    id,
  })

  /** Opens `file` as results `id`. A run's results send their layout with their first progress. */
  function register(id: string, file: ResultsFile, answered = true): Results {
    resultsById.set(id, file)
    files.add(file)
    cache.remove(file)
    if (answered) sentLayouts.set(id, file.layout)
    return resultsOf(id, file)
  }

  /** Closes results `id`. A file no longer in use becomes idle, or is retired while still read. */
  async function release(id: string): Promise<void> {
    const file = resultsById.get(id)
    resultsById.delete(id)
    sentLayouts.delete(id)
    if (!file || [...resultsById.values()].includes(file)) return
    if (file.progress.growing) return retire(file)
    cache.add(file, file.bytes, () => void retire(file))
  }

  /** Retires `file` and releases its store, removing it when `discarded`. */
  async function retire(file: ResultsFile, discarded = false): Promise<void> {
    files.delete(file)
    cache.remove(file)
    await file.retire()
    await (discarded ? stores.discard(file.store) : stores.release(file.store))
  }

  /** Reports `file`'s progress at most every PROGRESS_MS, unless `now`, with a trailing report so
   *  the last update of a burst is never lost. */
  function progressReporter(file: ResultsFile) {
    let last = -Infinity
    let trailing: ReturnType<typeof setTimeout> | undefined
    const report = () => {
      clearTimeout(trailing)
      trailing = undefined
      last = performance.now()
      const { layout, progress } = file
      for (const [id, bound] of resultsById) {
        if (bound !== file) continue
        send({
          kind: 'results',
          uri: layout.revision.uri,
          results: id,
          progress,
          ...(sentLayouts.get(id) !== layout && { layout }),
        })
        sentLayouts.set(id, layout)
      }
    }
    return (now = false) => {
      const wait = last + PROGRESS_MS - performance.now()
      if (now || wait <= 0) report()
      else trailing ??= setTimeout(report, wait)
    }
  }

  /** Logs a run's lines at their level. `flush` reports how many were omitted. */
  function logger(uri: string) {
    /** Whether GridKit has reported why the run stops. Later errors restate it while unwinding. */
    let reported = false
    let window = -Infinity
    let lines = 0
    let chars = 0
    let dropped = 0
    const flush = () => {
      if (dropped)
        send({ kind: 'log', uri, level: 'info', message: `${dropped} solver lines omitted.` })
      dropped = 0
    }
    return {
      line(text: string) {
        const line = solverLine(text, reported)
        if (!line) return
        reported ||= line.level === 'error'
        const now = performance.now()
        if (now - window > LOG_MS) {
          flush()
          window = now
          lines = chars = 0
        }
        chars += line.message.length
        if (line.level === 'error' || (++lines <= LOG_LINES && chars <= LOG_CHARS))
          send({ kind: 'log', uri, ...line })
        else dropped++
      },
      flush,
    }
  }

  /** A failure to start throws, and the returned run states how it ended. */
  async function runCase(input: WorkerApi['run']['input'], signal: AbortSignal): Promise<Run> {
    const { kase } = latest(input)
    const run: Run = {
      id: input.run,
      uri: input.uri,
      command: `${input.gridkit.program} ${basename(input.solver)}`,
      state: 'running',
    }
    runs++
    const log = logger(input.uri)
    let report: ((now?: boolean) => void) | undefined
    try {
      send({ kind: 'run', run })
      await simulate(kase, input, stores, {
        signal,
        wasm: options.solver,
        reading: (file) => {
          register(input.results, file, false)
          report = progressReporter(file)
          report(true)
        },
        progress: () => report?.(),
        log: log.line,
        lifecycle: (process) => send({ kind: 'process', run: run.id, process }),
        ...(options.runs && { runs: options.runs }),
      })
      run.state = 'complete'
    } catch (error) {
      // Closing the results while the run writes them stops it, as cancelling does.
      run.state = signal.aborted
        ? failedWith(signal.reason, 'interrupted')
          ? 'interrupted'
          : 'cancelled'
        : quiet(error)
          ? 'cancelled'
          : 'failed'
      if (run.state === 'failed') run.message = message(error)
      if (defect(error)) send({ kind: 'log', level: 'error', message: detail(error) })
    } finally {
      runs--
      log.flush()
      report?.(true)
      // Always send the final state, so the run never appears stuck.
      send({ kind: 'run', run })
    }
    return run
  }

  /** Opens a results file from a loaded copy, a committed store, or the CSV. Resolves once the
   *  first frames are read, and keeps reading until the results close. */
  async function openResults(
    { results, path, solver, ...revision }: WorkerApi['open']['input'],
    signal: AbortSignal,
  ): Promise<Results> {
    const { kase } = latest(revision)
    const now = stampOf(await stat(path, { bigint: true }))
    signal.throwIfAborted()
    const known = [...files].find(
      (file) =>
        file.of(path) &&
        file.layout.revision.uri === revision.uri &&
        file.kase.version === kase.version &&
        file.current(now),
    )
    if (known) return register(results, known)
    const reading = { revision, path, ...(solver && { solver }) }
    const stored = await stores.find(path, now, kase.version)
    let restored: ResultsFile | undefined
    if (stored) {
      let file: ResultsFile | undefined
      try {
        file = await ResultsFile.stored(kase, stored, reading)
      } catch (error) {
        // A damaged store is discarded and the CSV read again.
        if (!failedWith(error, 'results-lost')) {
          await stores.release(stored)
          throw error
        }
        await stores.discard(stored)
      }
      if (file) {
        if (signal.aborted) {
          await stores.release(stored)
          signal.throwIfAborted()
        }
        if (stored.manifest!.complete) return register(results, file)
        restored = file
      }
    }
    const file = restored ?? new ResultsFile(kase, await stores.create(path), reading)
    const report = progressReporter(file)
    // Before the reply, cancelling the request stops the reading. After it, closing the results
    // does.
    const stop = new AbortController()
    const abandon = () => stop.abort(signal.reason)
    signal.addEventListener('abort', abandon, { once: true })
    if (signal.aborted) abandon()
    let begin!: () => void
    const begun = new Promise<void>((resolve) => (begin = resolve))
    const read = file.use(stop.signal, (s) =>
      file.ingest(
        s,
        () => 'done',
        () => {
          begin()
          report()
        },
      ),
    )
    try {
      await Promise.race([begun, read])
      // No await follows before the reply, so a request cancelled by now leaves nothing open.
      signal.throwIfAborted()
    } catch (error) {
      // A store of a file that has since changed is discarded, and the file is read again in full.
      const stale = restored !== undefined && failedWith(error, 'results-lost')
      await retire(file, stale)
      if (stale)
        return openResults({ results, path, ...(solver && { solver }), ...revision }, signal)
      throw error
    } finally {
      signal.removeEventListener('abort', abandon)
    }
    // A read that stops early keeps what it read. settle() never rejects.
    void read.then(
      () => report(true),
      () => file.settle().then(() => report(true)),
    )
    return register(results, file)
  }

  const handlers: Pick<
    Handlers<WorkerApi>,
    | 'run'
    | 'open'
    | 'share'
    | 'close'
    | 'configure'
    | 'frames'
    | 'tile'
    | 'sample'
    | 'step'
    | 'export'
  > = {
    run: runCase,
    open: openResults,
    share: async ({ results, as }) => register(as, fileOf(results)),
    // The files themselves belong to the user and stay.
    async close({ results }) {
      await release(results)
      return null
    },
    async configure({ cacheBytes }) {
      cache.limit = cacheBytes
      return null
    },
    frames: (input, signal) => using(input.results, signal, (file, s) => file.frames(input, s)),
    tile: (input, signal) => using(input.results, signal, (file, s) => file.tile(input, s)),
    sample: (input, signal) => using(input.results, signal, (file, s) => file.sample(input, s)),
    step: ({ results, at, direction }, signal) =>
      using(results, signal, (file) => file.step(at, direction)),
    export: ({ results, path }, signal) =>
      using(results, signal, async (file) => {
        await file.exportCsv(path)
        return null
      }),
  }

  return {
    handlers,
    fileOf,
    stats() {
      const open = new Set(resultsById.values())
      return {
        results: resultsById.size,
        files: open.size,
        idle: files.size - open.size,
        runs,
        cacheBytes: cache.bytes,
      }
    },
  }
}
