/** The results worker: GridKit's runs, and the results files Studio reads, each against the case
 *  source it was read for. The views ask it for the frames they lack. Apart from the case worker,
 *  neither a long run nor a large file slows editing, nor editing a seek. */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

import { failure } from '@latkit/model'

import { catalog, presentation, simulate } from './gridkit/index.js'
import { solverLine } from './gridkit/solver.js'
import { described, PROGRESS_MS, ResultCache, ResultsFile } from './results/index.js'
import { Readers } from './results/readers.js'
import { defect, detail, message } from './shared/format.js'
import type { Request, Requests, Revision, Run } from './shared/messages.js'
import { CaseCache, summarize } from './worker/cases.js'
import { queried, rowsOf } from './worker/reads.js'
import { send, serve } from './worker/serve.js'

/** The cases results are read against, by their source. */
const sources = new CaseCache()
/** Each case's run under way. */
const running = new Map<string, { controller: AbortController; done: Promise<Run> }>()
/** The results files read for each case, the one shown first. */
const histories = new Map<string, ResultsFile[]>()
const readers = new Readers<ResultsFile>()
const cache = new ResultCache()
const cacheLimit = (value: number) => {
  if (!Number.isFinite(value) || value < 16 << 20 || value > 2048 * (1 << 20))
    throw new Error('Result cache must be between 16 and 2048 MiB.')
  return value
}
const nameOf = (uri: string) => uri.split('/').at(-1) ?? 'Case'
/** The case whose source is `text`, as the extension read it at `revision`. */
const caseOf = ({ uri, text }: Revision & { text: string }, signal: AbortSignal) =>
  sources.parse(text, catalog, nameOf(uri), signal)
const find = (id: string, uri?: string) => {
  for (const [key, files] of histories) {
    if (uri !== undefined && key !== uri) continue
    const file = files.find((file) => file.info.id === id)
    if (file) return file
  }
  throw Object.assign(new Error('These results are no longer read. Open them again.'), {
    code: 'results-unavailable',
  })
}

/** Keeps `file` as the case's shown results. Decoded chunks are bounded by ResultCache; past eight
 *  files read, the oldest no view reads and no case shows are let go. The files stay. */
function retain(uri: string, file: ResultsFile) {
  const files = histories.get(uri) ?? []
  files.unshift(file)
  histories.set(uri, files)
  const loaded = [...histories.values()].flat().sort((a, b) => a.info.started - b.info.started)
  for (const old of loaded.slice(0, Math.max(0, loaded.length - 8))) {
    const files = histories.get(old.info.revision.uri)!
    if (old === files[0] || old.info.growing || readers.busy(old)) continue
    files.splice(files.indexOf(old), 1)
    old.release()
  }
}

/** Runs GridKit as `input` says and reads what it writes. The request is the run, so cancelling
 *  it stops the run. Why it could not start is thrown; how it ended is in what it returns. */
async function runCase(input: Requests['run']['input'], signal: AbortSignal): Promise<Run> {
  if (running.has(input.uri)) throw failure('conflict', `${nameOf(input.uri)} is already running.`)
  const kase = await caseOf(input, signal)
  cache.limit = cacheLimit(input.cacheBytes)
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
    let lastProgress = 0
    let logWindow = 0
    let logCount = 0
    let dropped = 0
    /** Whether GridKit has said why the run stops; the errors after restate it as it unwinds. */
    let said = false
    try {
      send({ kind: 'run', run })
      await simulate(kase, input, run, cache, {
        signal: controller.signal,
        reading: (file) => {
          retain(input.uri, file)
          send({ kind: 'run', run })
        },
        progress: async () => {
          if (performance.now() - lastProgress > PROGRESS_MS) {
            send({ kind: 'run', run })
            lastProgress = performance.now()
          }
        },
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
      if (run.results) run.results.growing = false
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
async function openResults(input: Requests['open']['input'], signal: AbortSignal) {
  const kase = await caseOf(input, signal)
  cache.limit = cacheLimit(input.cacheBytes)
  const file = new ResultsFile(
    described(kase, input, input.path, {
      growing: true,
      started: (await stat(input.path)).mtimeMs,
      ...(input.contingency && { contingency: input.contingency }),
    }),
    kase,
    cache,
  )
  const { info } = file
  const stop = new AbortController()
  const abandon = () => stop.abort(signal.reason)
  signal.addEventListener('abort', abandon, { once: true })
  let begin!: () => void
  const begun = new Promise<void>((resolve) => (begin = resolve))
  let told = 0
  const reading = readers.use([file], stop.signal, async (s) => {
    try {
      await file.ingest(
        s,
        () => true,
        () => {
          begin()
          if (performance.now() - told < PROGRESS_MS) return
          told = performance.now()
          send({ kind: 'results', uri: input.uri, results: info })
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
    file.release()
    throw error
  } finally {
    signal.removeEventListener('abort', abandon)
  }
  retain(input.uri, file)
  void reading.then(
    () => send({ kind: 'results', uri: input.uri, results: info }),
    () => send({ kind: 'results', uri: input.uri, results: info }),
  )
  return info
}

async function dispatch(request: Request, signal: AbortSignal): Promise<unknown> {
  switch (request.method) {
    case 'describeResults': {
      // The views read the case's schema and counts; its issues are the case worker's to say.
      const file = find(request.input.results)
      return summarize(file.kase, file.info.revision)
    }
    case 'shutdown':
      for (const { controller } of running.values())
        controller.abort(
          Object.assign(new Error('The extension stopped before this simulation completed.'), {
            interrupted: true,
          }),
        )
      await Promise.allSettled([...running.values()].map(({ done }) => done))
      return null
    case 'query': {
      const { query, results, uri } = request.input
      const file = find(results!, uri)
      const at = query.kind === 'rows' ? query.at : undefined
      return queried(
        at === undefined ? file.kase.data : await file.data([at, at], signal),
        query,
        signal,
      )
    }
    case 'rows':
      return rowsOf(
        find(request.input.results!, request.input.uri).kase,
        request.input.fields,
        signal,
      )
    case 'presentation':
      return presentation(find(request.input.results!, request.input.uri).kase)
    case 'samples':
      return find(request.input.results).samples(request.input, signal)
    case 'step':
      return find(request.input.results).step(request.input.at, request.input.direction)
    case 'run':
      return runCase(request.input, signal)
    case 'open':
      return openResults(request.input, signal)
    case 'clear': {
      // Studio lets go of the case's results, stopping a run under way. Their files are the
      // user's, and stay.
      const uri = request.input.uri
      const active = running.get(uri)
      active?.controller.abort(new Error('Simulation cancelled.'))
      await active?.done
      const files = histories.get(uri) ?? []
      histories.delete(uri)
      for (const file of files) {
        await readers.retire(file)
        file.release()
      }
      return null
    }
    case 'export':
      await find(request.input.results).exportCsv(request.input.path, signal)
      return null
    case 'stats':
      return {
        memory: {
          heapUsed: process.memoryUsage().heapUsed,
          arrayBuffers: process.memoryUsage().arrayBuffers,
        },
        cacheBytes: cache.bytes,
        sessions: 0,
        results: [...histories.values()].reduce((n, files) => n + files.length, 0),
      }
    default:
      throw new Error(`The results worker does not answer ${request.method}.`)
  }
}

/** Each request of a results file reads it while it answers: letting go of the file waits. */
async function handle(request: Request, signal: AbortSignal) {
  const input = request.input
  const targets =
    'results' in input && typeof input.results === 'string'
      ? [find(input.results, 'uri' in input ? input.uri : undefined)]
      : []
  try {
    return await readers.use(targets, signal, (s) => dispatch(request, s))
  } finally {
    for (const target of targets)
      if (!histories.get(target.info.revision.uri)?.includes(target)) target.release()
  }
}

serve(handle, new Set(['query', 'rows', 'samples']))
