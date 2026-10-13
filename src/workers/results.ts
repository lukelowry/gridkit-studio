/** The results worker: GridKit's runs, and the results files Studio reads, each against the case
 *  source it was read for. The extension holds results by ids it chose, each of a file read once
 *  into a store of its own; several ids, as a view's and an export's, may hold one file. A file
 *  nothing holds rests under the one budget of what the worker keeps, so the same file opened
 *  again reads nothing, and a store read through outlives the worker, so a window opened again
 *  reads its results without their CSV. A case is kept only while a file read now, or a run under
 *  way, reads it. Apart from the case worker, neither a long run nor a large file slows editing,
 *  nor editing a seek. */

import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { workerData } from 'node:worker_threads'

import { Case, catalog, presentation, PROGRAM, simulate, sweepOrphans } from '../gridkit/index.js'
import { solverLine } from '../gridkit/solver.js'
import { closed, PROGRESS_MS, ResultCache, ResultsFile, stampOf, Stores } from '../results/index.js'
import { defect, detail, failedWith, message, problem, quiet } from '../shared/errors.js'
import type {
  CaseSource,
  Results,
  ResultsApi,
  ResultsLayout,
  ResultsOptions,
  Run,
} from '../shared/messages.js'
import { nameOf, summarize } from './parsed.js'
import { queried, rowsOf } from './reads.js'
import { memory, send, serve } from './serve.js'

/** How many lines, and characters, of a run the log hears each LOG_MS, besides the errors that say
 *  why it stops: the rest are counted, and the count said. */
const LOG_LINES = 100
const LOG_CHARS = 64 << 10
const LOG_MS = 1000

const options = workerData as ResultsOptions
const cache = new ResultCache(options.cacheBytes)
const stores = new Stores(options.store)
// What windows before left behind: stores no saved session names, and runs a window died during.
void stores.sweep(options.saved)
if (options.runs) void sweepOrphans(options.runs)

/** The results the extension holds, by the id it chose for each, and the file each holds. */
const held = new Map<string, ResultsFile>()
/** Every results file read now: held, or resting. */
const files = new Set<ResultsFile>()
/** The layout each results was last told with, which is told again only once it changes. */
const told = new Map<string, ResultsLayout>()
/** The runs under way, each with the case it runs. */
const running = new Set<{ readonly uri: string; readonly kase: Case }>()

/** The cases read now: those of the files read now and of the runs under way. */
function reading(): { readonly uri: string; readonly kase: Case }[] {
  return [
    ...running,
    ...[...files].map((file) => ({ uri: file.layout.revision.uri, kase: file.kase })),
  ]
}

/** The case `source` names, as a file read now or a run under way reads it; else read from its
 *  text, which the extension sends again when asked. Nothing else keeps a case: it goes with the
 *  last that reads it. */
async function caseOf({ uri, fingerprint, text }: CaseSource, signal: AbortSignal) {
  const known = reading().find((user) => user.uri === uri && user.kase.version === fingerprint)
  if (known) return known.kase
  if (text === undefined)
    throw problem('needs-source', 'The results worker has yet to read this case.')
  return Case.parse(text, catalog, nameOf(uri), signal)
}

/** The file the results `id` hold, while the extension holds them. */
function fileOf(id: string): ResultsFile {
  const file = held.get(id)
  if (!file) throw closed()
  return file
}

/** `read` of the file the results `id` hold, which letting go of the file stops. */
function using<R>(
  id: string,
  signal: AbortSignal,
  read: (file: ResultsFile, signal: AbortSignal) => Promise<R>,
): Promise<R> {
  const file = fileOf(id)
  return file.use(signal, (s) => read(file, s))
}

/** `file` as the results `id` hold it. */
const resultsOf = (id: string, file: ResultsFile): Results => ({
  ...file.layout,
  ...file.progress,
  id,
})

/** Holds `file` by `id`, waking it if it rested. Results an answer carries are told their layout
 *  already; a run's are told it first as it reads. */
function hold(id: string, file: ResultsFile, answered = true): Results {
  held.set(id, file)
  files.add(file)
  cache.wake(file)
  if (answered) told.set(id, file.layout)
  return resultsOf(id, file)
}

/** Lets go of the results `id`. Once nothing holds their file it rests, unless it is still being
 *  read, which stops. */
async function release(id: string): Promise<void> {
  const file = held.get(id)
  held.delete(id)
  told.delete(id)
  if (!file || [...held.values()].includes(file)) return
  if (file.progress.growing) return retire(file)
  cache.rest(file, file.bytes, () => void retire(file))
}

/** Lets go of `file` for good, and its store, which stays only while a saved session may name it. */
async function retire(file: ResultsFile): Promise<void> {
  files.delete(file)
  cache.wake(file)
  await file.retire()
  await stores.release(file.store)
}

/** What tells the extension how far `file` has been read, at most every PROGRESS_MS unless `now`:
 *  told meanwhile, it tells once that time is up, so the last of a burst is never kept back. */
function teller(file: ResultsFile) {
  let last = -Infinity
  let trailing: ReturnType<typeof setTimeout> | undefined
  const tell = () => {
    clearTimeout(trailing)
    trailing = undefined
    last = performance.now()
    const { layout, progress } = file
    for (const [id, holder] of held) {
      if (holder !== file) continue
      send({
        kind: 'results',
        uri: layout.revision.uri,
        results: id,
        progress,
        ...(told.get(id) !== layout && { layout }),
      })
      told.set(id, layout)
    }
  }
  return (now = false) => {
    const wait = last + PROGRESS_MS - performance.now()
    if (now || wait <= 0) tell()
    else trailing ??= setTimeout(tell, wait)
  }
}

/** What tells the extension each line a run of `uri` prints, at its level, and `flush`, which says
 *  how many went unsaid. */
function logger(uri: string) {
  /** Whether GridKit has said why the run stops; the errors after restate it as it unwinds. */
  let said = false
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
      const line = solverLine(text, said)
      if (!line) return
      said ||= line.level === 'error'
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

/** Runs GridKit as `input` says and reads what it writes into the results it names. The request is
 *  the run, so cancelling it stops the run. Why it could not start is thrown; how it ended is in
 *  what it returns. */
async function runCase(input: ResultsApi['run']['input'], signal: AbortSignal): Promise<Run> {
  const kase = await caseOf(input, signal)
  const run: Run = {
    id: input.run,
    uri: input.uri,
    command: `${PROGRAM} ${basename(input.solver)}`,
    state: 'running',
  }
  const reader = { uri: input.uri, kase }
  running.add(reader)
  const log = logger(input.uri)
  /** What tells of the results the run writes, once it begins to. */
  let tell: ((now?: boolean) => void) | undefined
  try {
    send({ kind: 'run', run })
    await simulate(
      kase,
      input,
      { cache, stores },
      {
        signal,
        reading: (file) => {
          hold(input.results, file, false)
          tell = teller(file)
          tell(true)
        },
        progress: () => tell?.(),
        log: log.line,
        lifecycle: (process) => send({ kind: 'process', run: run.id, process }),
        ...(options.runs && { runs: options.runs }),
      },
    )
    run.state = 'complete'
  } catch (error) {
    // Results let go of while the run writes them stop it, as cancelling it does.
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
    running.delete(reader)
    log.flush()
    tell?.(true)
    // The run's last state goes out whatever its cleanup meets, so it never stays running.
    send({ kind: 'run', run })
  }
  return run
}

/** Reads the GridKit results file `input` names into the results it names: Open Results…, a session
 *  read again, or a worker started again. A file read now of the same content is held again, and
 *  one a store read through holds is read from the store; else its CSV is read, its header saying
 *  what it holds. It answers once the first frames are read; the rest are read on, the views
 *  hearing as they come, until the extension lets go of the results. */
async function openResults(
  { results, path, solver, ...source }: ResultsApi['open']['input'],
  signal: AbortSignal,
): Promise<Results> {
  const kase = await caseOf(source, signal)
  const now = stampOf(await stat(path, { bigint: true }))
  signal.throwIfAborted()
  const known = [...files].find(
    (file) =>
      file.of(path) &&
      file.layout.revision.uri === source.uri &&
      file.kase.version === kase.version &&
      file.current(now),
  )
  if (known) return hold(results, known)
  const reading = { revision: source, path, ...(solver && { solver }) }
  const stored = await stores.find(path, now, kase.version)
  if (stored) {
    let file: ResultsFile | undefined
    try {
      file = await ResultsFile.stored(kase, cache, stored, reading)
    } catch {
      // A store that does not read goes, and the file is read again from its CSV.
      await stores.discard(stored)
    }
    if (file) {
      if (signal.aborted) {
        await stores.release(stored)
        signal.throwIfAborted()
      }
      return hold(results, file)
    }
  }
  const file = new ResultsFile(kase, cache, await stores.create(path), reading)
  const tell = teller(file)
  // Until it answers, letting go of the request stops the reading; after, letting go of the
  // results does.
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
        tell()
      },
    ),
  )
  try {
    // A file whose first frames do not read does not open.
    await Promise.race([begun, read])
    // From here to the answer nothing waits: a request let go of by now holds nothing.
    signal.throwIfAborted()
  } catch (error) {
    await retire(file)
    throw error
  } finally {
    signal.removeEventListener('abort', abandon)
  }
  void read.then(
    () => tell(true),
    () => tell(true),
  )
  return hold(results, file)
}

serve<ResultsApi>(
  {
    run: runCase,
    open: openResults,
    share: async ({ results, as }) => hold(as, fileOf(results)),
    // The extension lets go of results it no longer shows. Their files are the user's, and stay.
    async close({ results }) {
      await release(results)
      return null
    },
    async configure({ cacheBytes }) {
      cache.limit = cacheBytes
      return null
    },
    // The views read the case's schema and counts; its issues are the case worker's to say.
    async describe({ results }, signal) {
      const file = fileOf(results)
      return summarize(file.kase, file.layout.revision, { signal })
    },
    query: ({ results, query }, signal) =>
      using(results, signal, async (file, s) => {
        // Rows at a time read the samples of their own type alone.
        if (query.kind !== 'rows' || query.at === undefined)
          return queried(file.kase.data, query, s)
        return queried(await file.data([query.at, query.at], s, query.from), query, s)
      }),
    rows: ({ results, fields }, signal) => rowsOf(fileOf(results).kase, fields, signal),
    presentation: ({ results }, signal) => presentation(fileOf(results).kase, signal),
    samples: (input, signal) => using(input.results, signal, (file, s) => file.samples(input, s)),
    step: async ({ results, at, direction }) => fileOf(results).step(at, direction),
    export: ({ results, path }, signal) =>
      using(results, signal, async (file) => {
        await file.exportCsv(path)
        return null
      }),
    stats: async () => {
      const holding = new Set(held.values())
      return {
        memory: memory(),
        results: held.size,
        files: holding.size,
        resting: files.size - holding.size,
        cases: new Set(reading().map(({ kase }) => kase)).size,
        runs: running.size,
        cacheBytes: cache.bytes,
      }
    },
  },
  ['query', 'rows', 'samples'],
)
