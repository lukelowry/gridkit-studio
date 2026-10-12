/** The results worker: GridKit's runs, and the results files Studio reads, each against the case
 *  source it was read for. It holds exactly what the extension holds: each results file by the id
 *  the extension chose for it, until the extension closes it, and a case only while a file it holds
 *  or a run under way reads it. Apart from the case worker, neither a long run nor a large file
 *  slows editing, nor editing a seek. */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { workerData } from 'node:worker_threads'

import { Case, catalog, presentation, PROGRAM, simulate } from '../gridkit/index.js'
import { solverLine } from '../gridkit/solver.js'
import { closed, PROGRESS_MS, ResultCache, ResultsFile } from '../results/index.js'
import { defect, detail, failedWith, message, problem, quiet } from '../shared/errors.js'
import type { CaseSource, ResultsApi, ResultsOptions, Run } from '../shared/messages.js'
import { nameOf, summarize } from './parsed.js'
import { queried, rowsOf } from './reads.js'
import { memory, send, serve } from './serve.js'

/** How many lines of a run the log hears each LOG_MS, besides the error that says why it stops: the
 *  rest are counted, and the count said. */
const LOG_LINES = 100
const LOG_MS = 1000

/** The results files the extension holds, by the id it chose for each. */
const files = new Map<string, ResultsFile>()
/** The runs under way, each with the case it runs. */
const running = new Set<{ readonly uri: string; readonly kase: Case }>()
const cache = new ResultCache((workerData as ResultsOptions).cacheBytes)

/** The cases read now: those of the files held and of the runs under way. */
function reading(): { readonly uri: string; readonly kase: Case }[] {
  return [
    ...running,
    ...[...files.values()].map((file) => ({ uri: file.info.revision.uri, kase: file.kase })),
  ]
}

/** The case `source` names, as a file held or a run under way reads it; else read from its text,
 *  which the extension sends again when asked. Nothing else keeps a case: it goes with the last
 *  that reads it. */
async function caseOf({ uri, fingerprint, text }: CaseSource, signal: AbortSignal) {
  const known = reading().find((user) => user.uri === uri && user.kase.version === fingerprint)
  if (known) return known.kase
  if (text === undefined)
    throw problem('needs-source', 'The results worker has yet to read this case.')
  return Case.parse(text, catalog, nameOf(uri), signal)
}

/** The results `id` names, while the extension holds them. */
function held(id: string): ResultsFile {
  const file = files.get(id)
  if (!file) throw closed()
  return file
}

/** `read` of the results `id` names, which closing them stops. */
function using<R>(
  id: string,
  signal: AbortSignal,
  read: (file: ResultsFile, signal: AbortSignal) => Promise<R>,
): Promise<R> {
  const file = held(id)
  return file.use(signal, (s) => read(file, s))
}

/** What tells the extension how far `file` has been read: at most every PROGRESS_MS, unless `now`. */
function teller(file: ResultsFile) {
  let told = -Infinity
  return (now = false) => {
    if (!now && performance.now() - told < PROGRESS_MS) return
    told = performance.now()
    send({ kind: 'results', uri: file.info.revision.uri, results: file.info })
  }
}

/** What tells the extension each line a run of `uri` prints, at its level, and `flush`, which says
 *  how many went unsaid. */
function logger(uri: string) {
  /** Whether GridKit has said why the run stops; the errors after restate it as it unwinds. */
  let said = false
  let window = -Infinity
  let count = 0
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
        count = 0
      }
      if (line.level === 'error' || ++count <= LOG_LINES) send({ kind: 'log', uri, ...line })
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
    id: randomUUID(),
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
    await simulate(kase, input, cache, {
      signal,
      reading: (file) => {
        files.set(file.info.id, file)
        tell = teller(file)
        tell(true)
      },
      progress: () => tell?.(),
      log: log.line,
      lifecycle: (process) => send({ kind: 'process', uri: input.uri, process }),
    })
    run.state = 'complete'
  } catch (error) {
    // Results closed while the run writes them stop it, as cancelling it does.
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
 *  read again, or a worker started again. Its header says what it holds. It answers once the first
 *  frames are read; the rest are read on, the views hearing as they come, until the extension
 *  closes the results. */
async function openResults(
  { results, path, solver, ...source }: ResultsApi['open']['input'],
  signal: AbortSignal,
) {
  const kase = await caseOf(source, signal)
  const file = new ResultsFile(kase, cache, {
    id: results,
    revision: source,
    path,
    ...(solver && { solver }),
  })
  const tell = teller(file)
  // Until it answers, letting go of the request stops the reading; after, closing the results does.
  const stop = new AbortController()
  const abandon = () => stop.abort(signal.reason)
  signal.addEventListener('abort', abandon, { once: true })
  if (signal.aborted) abandon()
  let begin!: () => void
  const begun = new Promise<void>((resolve) => (begin = resolve))
  const read = file.use(stop.signal, (s) =>
    file.ingest(
      s,
      () => true,
      () => {
        begin()
        tell()
      },
    ),
  )
  try {
    // A file whose first frames do not read does not open.
    await Promise.race([begun, read])
  } catch (error) {
    await file.retire()
    throw error
  } finally {
    signal.removeEventListener('abort', abandon)
  }
  // From here to the answer nothing waits: a request let go of by now holds nothing.
  if (signal.aborted) {
    await file.retire()
    signal.throwIfAborted()
  }
  files.set(results, file)
  void read.then(
    () => tell(true),
    () => tell(true),
  )
  return file.info
}

serve<ResultsApi>(
  {
    run: runCase,
    open: openResults,
    // The extension lets go of results it no longer shows. Their files are the user's, and stay.
    async close({ results }) {
      const file = files.get(results)
      files.delete(results)
      await file?.retire()
      return null
    },
    async configure({ cacheBytes }) {
      cache.limit = cacheBytes
      return null
    },
    // The views read the case's schema and counts; its issues are the case worker's to say.
    async describe({ results }) {
      const file = held(results)
      return summarize(file.kase, file.info.revision)
    },
    query: ({ results, query }, signal) =>
      using(results, signal, async (file, s) => {
        // Rows at a time read the samples of their own type alone.
        if (query.kind !== 'rows' || query.at === undefined)
          return queried(file.kase.data, query, s)
        return queried(await file.data([query.at, query.at], s, query.from), query, s)
      }),
    rows: ({ results, fields }, signal) => rowsOf(held(results).kase, fields, signal),
    presentation: async ({ results }) => presentation(held(results).kase),
    samples: (input, signal) => using(input.results, signal, (file, s) => file.samples(input, s)),
    step: async ({ results, at, direction }) => held(results).step(at, direction),
    export: ({ results, path }, signal) =>
      using(results, signal, async (file) => {
        await file.exportCsv(path)
        return null
      }),
    stats: async () => ({
      memory: memory(),
      files: files.size,
      cases: new Set(reading().map(({ kase }) => kase)).size,
      runs: running.size,
      cacheBytes: cache.bytes,
    }),
  },
  ['query', 'rows', 'samples'],
)
