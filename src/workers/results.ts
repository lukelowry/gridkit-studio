/** The results worker: GridKit's runs, and the results files Studio reads, each against the case
 *  source it was read for. The views ask it for the frames they lack. Apart from the case worker,
 *  neither a long run nor a large file slows editing, nor editing a seek. */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

import { failure } from '@latkit/model'

import { catalog, presentation, simulate } from '../gridkit/index.js'
import { solverLine } from '../gridkit/solver.js'
import { described, PROGRESS_MS, ResultCache, ResultsFile } from '../results/index.js'
import { defect, detail, message } from '../shared/format.js'
import type { CaseSource, ResultsApi, Run } from '../shared/messages.js'
import { CaseCache, summarize } from './parsed.js'
import { queried, rowsOf } from './reads.js'
import { send, serve } from './serve.js'
import { Shelf } from './shelf.js'

/** The cases results are read against, by their source. */
const sources = new CaseCache()
/** Each case's run under way. */
const running = new Map<string, { controller: AbortController; done: Promise<Run> }>()
const shelf = new Shelf()
const cache = new ResultCache()
const nameOf = (uri: string) => uri.split('/').at(-1) ?? 'Case'
/** The case `source` names: one read before, by its fingerprint, else its text, which the extension
 *  sends again when asked. */
async function caseOf({ uri, fingerprint, text }: CaseSource, signal: AbortSignal) {
  const known = sources.find(uri, fingerprint)
  if (known) return known
  if (text === undefined)
    throw Object.assign(new Error('The results worker has yet to read this case.'), {
      code: 'needs-source',
    })
  return sources.parse(uri, text, catalog, nameOf(uri), signal)
}

/** What tells the extension how far `file` has been read: at most every PROGRESS_MS, unless `now`. */
function teller(uri: string, file: ResultsFile) {
  let told = -Infinity
  return (now = false) => {
    if (!now && performance.now() - told < PROGRESS_MS) return
    told = performance.now()
    send({ kind: 'results', uri, results: file.info })
  }
}

/** `read` of the results `id` names, which letting go of them stops. */
function withResults<R>(
  id: string,
  signal: AbortSignal,
  read: (file: ResultsFile, signal: AbortSignal) => Promise<R>,
): Promise<R> {
  const file = shelf.find(id)
  return file.use(signal, (s) => read(file, s))
}

/** Runs GridKit as `input` says and reads what it writes. The request is the run, so cancelling
 *  it stops the run. Why it could not start is thrown; how it ended is in what it returns. */
async function runCase(input: ResultsApi['run']['input'], signal: AbortSignal): Promise<Run> {
  if (running.has(input.uri)) throw failure('conflict', `${nameOf(input.uri)} is already running.`)
  const kase = await caseOf(input, signal)
  cache.limit = input.cacheBytes
  const run: Run = {
    id: randomUUID(),
    uri: input.uri,
    command: `${input.program} ${basename(input.solver)}`,
    state: 'running',
  }
  const controller = new AbortController()
  const cancel = () => controller.abort(new Error('Simulation cancelled.'))
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const done = (async () => {
    let logWindow = 0
    let logCount = 0
    let dropped = 0
    /** Whether GridKit has said why the run stops; the errors after restate it as it unwinds. */
    let said = false
    /** The results file the run writes, once it begins to, and what tells of it. */
    let writing: { file: ResultsFile; tell: (now?: boolean) => void } | undefined
    try {
      send({ kind: 'run', run })
      await simulate(kase, input, run, cache, {
        signal: controller.signal,
        reading: (file) => {
          shelf.keep(file)
          writing = { file, tell: teller(input.uri, file) }
          send({ kind: 'run', run })
          writing.tell(true)
        },
        progress: async () => writing?.tell(),
        // Each line at its level, at most 100 a second; the rest are counted, and the count sent.
        log: (text) => {
          const line = solverLine(text, input.program, said)
          if (!line) return
          said ||= line.level === 'error'
          if (Date.now() - logWindow > 1000) {
            if (dropped)
              send({
                kind: 'log',
                uri: input.uri,
                level: 'info',
                message: `${dropped} solver lines omitted.`,
              })
            dropped = 0
            logWindow = Date.now()
            logCount = 0
          }
          if (++logCount <= 100) send({ kind: 'log', uri: input.uri, ...line })
          else dropped++
        },
        lifecycle: (process) => send({ kind: 'process', uri: input.uri, process }),
      })
      run.state = 'complete'
    } catch (error) {
      run.state = controller.signal.aborted
        ? controller.signal.reason?.interrupted
          ? 'interrupted'
          : 'cancelled'
        : 'failed'
      run.message = message(error)
      if (defect(error)) send({ kind: 'log', level: 'error', message: detail(error) })
    } finally {
      if (writing) {
        writing.file.info.growing = false
        writing.tell(true)
      }
      // The run's last state goes out whatever its cleanup meets, so it never stays running.
      send({ kind: 'run', run })
    }
    return run
  })()
  running.set(input.uri, { controller, done })
  try {
    return await done
  } finally {
    running.delete(input.uri)
    signal.removeEventListener('abort', cancel)
  }
}

/** A GridKit results file read for the case: Open Results…, a session restored after a reload,
 *  or another contingency of a study. Its header says what it holds. It answers once the first
 *  frames are read; the rest are read on, the views hearing as they come, until clearing the case's
 *  results lets go of them. */
async function openResults(input: ResultsApi['open']['input'], signal: AbortSignal) {
  const kase = await caseOf(input, signal)
  cache.limit = input.cacheBytes
  const started = (await stat(input.path)).mtimeMs
  // A file read whole and unchanged since, as when a study shows a contingency again, is read.
  const kept = shelf.reopen(input.uri, input.path, kase.version, started)
  if (kept) {
    kept.info.revision = { uri: input.uri, version: input.version }
    if (input.contingency) kept.info.contingency = input.contingency
    return kept.info
  }
  const file = new ResultsFile(
    described(kase, input, input.path, {
      growing: true,
      started,
      ...(input.contingency && { contingency: input.contingency }),
      ...(input.solver && { solver: input.solver }),
    }),
    kase,
    cache,
  )
  const { info } = file
  const tell = teller(input.uri, file)
  const stop = new AbortController()
  const abandon = () => stop.abort(signal.reason)
  signal.addEventListener('abort', abandon, { once: true })
  if (signal.aborted) abandon()
  let begin!: () => void
  const begun = new Promise<void>((resolve) => (begin = resolve))
  const reading = file.use(stop.signal, async (s) => {
    try {
      await file.ingest(
        s,
        () => true,
        () => {
          begin()
          tell()
        },
      )
    } catch (error) {
      if (!s.aborted) info.error = message(error)
      throw error
    } finally {
      info.growing = false
    }
  })
  try {
    // A file whose first frames do not read does not open.
    await Promise.race([begun, reading])
  } catch (error) {
    await file.retire()
    throw error
  } finally {
    signal.removeEventListener('abort', abandon)
  }
  shelf.keep(file)
  void reading.then(
    () => tell(true),
    () => tell(true),
  )
  return info
}

serve<ResultsApi>(
  {
    run: runCase,
    open: openResults,
    // The views read the case's schema and counts; its issues are the case worker's to say.
    async describe({ results }) {
      const file = shelf.find(results)
      return summarize(file.kase, file.info.revision)
    },
    query: ({ results, query }, signal) =>
      withResults(results, signal, async (file, s) => {
        const at = query.kind === 'rows' ? query.at : undefined
        return queried(at === undefined ? file.kase.data : await file.data([at, at], s), query, s)
      }),
    rows: ({ results, fields }, signal) => rowsOf(shelf.find(results).kase, fields, signal),
    presentation: async ({ results }) => presentation(shelf.find(results).kase),
    samples: (input, signal) =>
      withResults(input.results, signal, (file, s) => file.samples(input, s)),
    step: async ({ results, at, direction }) => shelf.find(results).step(at, direction),
    export: ({ results, path }, signal) =>
      withResults(results, signal, async (file, s) => {
        await file.exportCsv(path, s)
        return null
      }),
    // Studio lets go of the case's results, stopping a run under way. Their files are the user's,
    // and stay.
    async clear({ uri }) {
      const active = running.get(uri)
      active?.controller.abort(new Error('Simulation cancelled.'))
      await active?.done
      await shelf.clear(uri)
      sources.forget(uri)
      return null
    },
    async shutdown() {
      for (const { controller } of running.values())
        controller.abort(
          Object.assign(new Error('The extension stopped before this simulation completed.'), {
            interrupted: true,
          }),
        )
      await Promise.allSettled([...running.values()].map(({ done }) => done))
      return null
    },
    stats: async () => ({
      memory: {
        heapUsed: process.memoryUsage().heapUsed,
        arrayBuffers: process.memoryUsage().arrayBuffers,
      },
      files: shelf.size,
      cacheBytes: cache.bytes,
    }),
  },
  ['query', 'rows', 'samples'],
)
