import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { parentPort } from 'node:worker_threads'

import {
  blockBuffers,
  failure,
  type QueryBlock,
  read,
  type RowBatch,
  selectBatches,
} from '@latkit/model'

import { diagnoseAsync } from './gridkit/edits.js'
import {
  applyChanges,
  Case,
  catalog,
  completionsAt,
  presentation,
  simulate,
  sourceContext,
  sourceRange,
  transaction,
} from './gridkit/index.js'
import { anchors } from './gridkit/inspection.js'
import { solverLine } from './gridkit/solver.js'
import { described, PROGRESS_MS, ResultCache, ResultsFile } from './results/index.js'
import { Readers } from './results/readers.js'
import { failureOf } from './shared/errors.js'
import { defect, detail, message } from './shared/format.js'
import type {
  FromWorker,
  Request,
  Requests,
  Results,
  Revision,
  Run,
  SimulationRequest,
  Summary,
  ToWorker,
} from './shared/messages.js'
import { CaseCache, summarize } from './worker/cases.js'

const port = parentPort!
const BLOCK_BYTES = 256 << 10
const cases = new Map<string, { kase: Case; summary: Summary; generation: object }>()
const sources = new CaseCache()
const parses = new Map<string, object>()
const attachments = new Map<string, string | undefined>()
const mirrors = new Map<string, { version: number; text: string }>()
const operations = new Map<number, AbortController>()
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
const send = (message: FromWorker, buffers: readonly ArrayBufferLike[] = []) =>
  port.postMessage(
    message,
    buffers.filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer),
  )
/** The case parsed at `revision`; throws unless it is the latest parse. */
const get = (revision: Revision) => {
  const entry = cases.get(revision.uri)
  if (
    !entry ||
    entry.summary.version !== revision.version ||
    parses.get(revision.uri) !== entry.generation ||
    (revision.attachmentId !== undefined && attachments.get(revision.uri) !== revision.attachmentId)
  )
    throw Object.assign(new Error('The document changed. Wait for the current revision.'), {
      code: 'stale',
    })
  return entry
}
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
async function runCase(input: SimulationRequest, signal: AbortSignal): Promise<Run> {
  const { kase } = get(input)
  if (running.has(input.uri)) throw failure('conflict', `${kase.name} is already running.`)
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
 *  or another contingency of a study. Its header says what it holds. It answers only its caller. */
async function openResults(
  input: Requests['open']['input'],
  signal: AbortSignal,
): Promise<Results> {
  const { kase } = get(input)
  cache.limit = cacheLimit(input.cacheBytes)
  const file = new ResultsFile(
    described(kase, input, input.path, {
      started: (await stat(input.path)).mtimeMs,
      ...(input.contingency && { contingency: input.contingency }),
    }),
    kase,
    cache,
  )
  await readers.use([file], signal, (s) =>
    file.ingest(
      s,
      () => true,
      () => {},
    ),
  )
  retain(input.uri, file)
  return file.info
}

async function dispatch(request: Request, signal: AbortSignal): Promise<unknown> {
  switch (request.method) {
    case 'describeResults': {
      const file = find(request.input.results)
      return summarize(file.kase, file.info.revision, 0, await diagnoseAsync(file.kase, signal))
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
    case 'anchors':
      return anchors(get(request.input).kase, request.input, signal)
    case 'parse': {
      const { uri, version, attachmentId } = request.input
      const previous = mirrors.get(uri)
      if (
        !('text' in request.input) &&
        (previous?.version !== request.input.baseVersion || attachments.get(uri) !== attachmentId)
      )
        throw new Error('Source mirror is stale.')
      const text =
        'text' in request.input
          ? request.input.text
          : applyChanges(previous!.text, request.input.changes)
      mirrors.set(uri, { version, text })
      const generation = {}
      parses.set(uri, generation)
      attachments.set(uri, attachmentId)
      const started = performance.now()
      const kase = await sources.parse(text, catalog, uri.split('/').at(-1) ?? 'Case', signal)
      signal.throwIfAborted()
      if (parses.get(uri) !== generation || attachments.get(uri) !== attachmentId)
        throw new Error('Superseded document revision.')
      const summary = summarize(kase, { uri, version, attachmentId }, performance.now() - started)
      cases.set(uri, { kase, summary, generation })
      return summary
    }
    case 'validate': {
      const entry = get(request.input)
      const issues = await diagnoseAsync(entry.kase, signal)
      if (get(request.input) !== entry) throw new Error('Superseded document revision.')
      entry.summary = { ...entry.summary, issues, validation: 'complete' }
      return issues
    }
    case 'query': {
      const { query, results, uri } = request.input
      const file = results ? find(results, uri) : undefined
      const kase = file?.kase ?? get(request.input).kase
      const at = query.kind === 'rows' ? query.at : undefined
      const data = file && at !== undefined ? await file.data([at, at], signal) : kase.data
      const blocks: QueryBlock[] = []
      for await (const block of read(data, query, {
        signal,
        maxBlockBytes: BLOCK_BYTES,
        buffers: 'owned',
      }))
        blocks.push(block)
      return blocks
    }
    case 'rows': {
      const { fields, results, uri } = request.input
      const kase = results ? find(results, uri).kase : get(request.input).kase
      // A field the case samples comes with a results file, never with the rows.
      const statics = fields
        .map((field) => ({
          ...field,
          select: field.select.filter(
            (name) => !kase.schema.types[field.from]!.fields[name]!.sampled,
          ),
        }))
        .filter((field) => field.select.length > 0)
      const batches: RowBatch[] = []
      for await (const batch of selectBatches(kase.data, statics, {
        signal,
        maxBlockBytes: BLOCK_BYTES,
        buffers: 'owned',
      }))
        if (batch.kind === 'rows') batches.push(batch)
      return batches
    }
    case 'samples':
      return find(request.input.results).samples(request.input, signal)
    case 'complete':
      return completionsAt(catalog, request.input.text, request.input.offset)
    case 'context':
      return sourceContext(get(request.input).kase, request.input.offset)
    case 'symbols': {
      const { kase } = get(request.input)
      const symbols = []
      for (const table of kase.tables.values())
        for (let row = 0; row < table.records.length && symbols.length < 10000; row++) {
          signal.throwIfAborted()
          const id = kase.id(table, row)
          symbols.push({
            ...sourceRange(kase, id),
            name: id,
            detail: table.shape.definition.label ?? table.shape.type,
          })
        }
      return symbols
    }
    case 'step':
      return find(request.input.results).step(request.input.at, request.input.direction)
    case 'transact':
      return transaction(get(request.input).kase, request.input.mutations)
    case 'presentation':
      return presentation(get(request.input).kase)
    case 'locate':
      return sourceRange(get(request.input).kase, request.input.id, request.input.field)
    case 'run':
      return runCase(request.input, signal)
    case 'open':
      return openResults(request.input, signal)
    case 'release': {
      const uri = request.input.uri
      if (request.input.attachmentId && attachments.get(uri) !== request.input.attachmentId)
        return null
      cases.delete(uri)
      parses.delete(uri)
      mirrors.delete(uri)
      attachments.delete(uri)
      return null
    }
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
        sessions: cases.size,
        results: [...histories.values()].reduce((n, files) => n + files.length, 0),
      }
  }
}

/** What a reply carries in buffers of its own, which go to the extension without a copy. */
const TRANSFERRED: ReadonlySet<string> = new Set(['query', 'rows', 'samples'])

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
port.on('message', (request: ToWorker) => {
  if (request.kind === 'cancel') return operations.get(request.id)?.abort(new Error('Cancelled'))
  const controller = new AbortController()
  operations.set(request.id, controller)
  const fail = (error: unknown) =>
    send({
      kind: 'error',
      id: request.id,
      problem: failureOf(error, controller.signal.aborted),
      offset: (error as { offset?: number } | null)?.offset,
      length: (error as { length?: number } | null)?.length,
      ...(defect(error) && { defect: true, detail: detail(error) }),
    })
  void handle(request, controller.signal)
    .then((value) => {
      try {
        send(
          { kind: 'result', id: request.id, value },
          TRANSFERRED.has(request.method) ? blockBuffers(value) : [],
        )
      } catch (error) {
        // A value that cannot cross to the extension is a defect, answered as one.
        fail(Object.assign(new Error(message(error)), { defect: true, detail: detail(error) }))
      }
    }, fail)
    .finally(() => operations.delete(request.id))
})
