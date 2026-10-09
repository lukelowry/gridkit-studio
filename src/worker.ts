import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { parentPort } from 'node:worker_threads'

import {
  blockBuffers,
  type DataBatch,
  failure,
  type QueryBlock,
  read,
  rowCount,
  selectBatches,
  selectRows,
  staticFields,
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
import { PROGRESS_MS, ResultCache, Results } from './results/index.js'
import { Readers } from './results/readers.js'
import { intersectRows, recordedSelection, type SampleCoverage } from './shared/coverage.js'
import { failureOf } from './shared/errors.js'
import { defect, detail, message } from './shared/format.js'
import type {
  FromWorker,
  Request,
  Requests,
  Revision,
  SimulationInfo,
  SimulationRequest,
  Summary,
  ToWorker,
} from './shared/messages.js'
import { packets, sendAhead } from './worker/batches.js'
import { CaseCache, summarize } from './worker/cases.js'

const port = parentPort!
const BLOCK_BYTES = 256 << 10
/** A run's samples stream in blocks this large, several to a packet. The view keeps each block as a
 *  page of its own, so a few large blocks are less for it to keep than many small ones. */
const SAMPLE_BLOCK_BYTES = 4 << 20
const PACKET_BYTES = 8 << 20
const cases = new Map<string, { kase: Case; summary: Summary; generation: object }>()
const sources = new CaseCache()
const parses = new Map<string, object>()
const attachments = new Map<string, string | undefined>()
const mirrors = new Map<string, { version: number; text: string }>()
const operations = new Map<number, AbortController>()
const acknowledgements = new Map<number, () => void>()
/** Each case's run under way. */
const running = new Map<string, { controller: AbortController; done: Promise<SimulationInfo> }>()
/** The results files read for each case, the one shown first. */
const histories = new Map<string, Results[]>()
const readers = new Readers<Results>()
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
const findRun = (id: string, uri?: string) => {
  for (const [key, runs] of histories) {
    if (uri !== undefined && key !== uri) continue
    const run = runs.find((run) => run.info.id === id)
    if (run) return run
  }
  throw Object.assign(new Error('These results are no longer read. Open them again.'), {
    code: 'results-unavailable',
    simulationId: id,
  })
}

/** Sends `batches` for request `id`; resolves once the view acknowledges them. */
async function emit(id: number, batches: readonly DataBatch[], signal: AbortSignal) {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(failure('timeout', 'View stopped consuming data.'))
    }, 30000)
    const cleanup = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      acknowledgements.delete(id)
    }
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    acknowledgements.set(id, () => {
      cleanup()
      resolve()
    })
    signal.addEventListener('abort', abort, { once: true })
    send({ kind: 'batch', id, batches }, blockBuffers(batches))
  })
}
/** Keeps `run` as the case's shown results. Decoded pages are bounded by ResultCache; past eight
 *  results read, the oldest no view reads and no case shows are let go. Their files stay. */
function retain(uri: string, run: Results) {
  const runs = histories.get(uri) ?? []
  runs.unshift(run)
  histories.set(uri, runs)
  const loaded = [...histories.values()].flat().sort((a, b) => a.info.started - b.info.started)
  for (const old of loaded.slice(0, Math.max(0, loaded.length - 8))) {
    const runs = histories.get(old.info.revision.uri)!
    if (old === runs[0] || old.info.state === 'running' || readers.busy(old)) continue
    runs.splice(runs.indexOf(old), 1)
    old.release()
  }
}

/** Runs GridKit as `input` says and reads what it writes. The request is the run, so cancelling
 *  it stops the run. Why it could not start is thrown; how it ended is in what it returns. */
async function runCase(input: SimulationRequest, signal: AbortSignal): Promise<SimulationInfo> {
  const { kase } = get(input)
  if (running.has(input.uri)) throw failure('conflict', `${kase.name} is already running.`)
  cache.limit = cacheLimit(input.cacheBytes)
  const info: SimulationInfo = {
    id: crypto.randomUUID(),
    command: `${input.program} ${basename(input.solver)}`,
    revision: { uri: input.uri, version: input.version },
    fingerprint: kase.version,
    name: kase.name,
    state: 'running',
    path: input.output,
    format: input.format,
    frames: 0,
    domain: [0, 0],
    span: [0, input.tmax],
    started: Date.now(),
    outputs: [],
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
      send({ kind: 'run', info })
      await simulate(kase, input, info, cache, {
        signal: controller.signal,
        reading: (results) => retain(input.uri, results),
        publish: async () => {
          if (performance.now() - lastProgress > PROGRESS_MS) {
            send({ kind: 'run', info })
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
      info.state = 'complete'
    } catch (error) {
      info.state = controller.signal.aborted
        ? controller.signal.reason?.interrupted
          ? 'interrupted'
          : 'cancelled'
        : 'failed'
      info.message = message(error)
      if (defect(error)) send({ kind: 'log', level: 'error', message: detail(error) })
    } finally {
      // The run's last state goes out whatever its cleanup meets, so it never stays running.
      send({ kind: 'run', info })
    }
    return info
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
async function openResults(input: Requests['open']['input'], signal: AbortSignal) {
  const { kase } = get(input)
  cache.limit = cacheLimit(input.cacheBytes)
  const info: SimulationInfo = {
    id: crypto.randomUUID(),
    revision: { uri: input.uri, version: input.version },
    fingerprint: kase.version,
    name: basename(input.path),
    state: 'complete',
    path: input.path,
    format: extname(input.path).toLowerCase() === '.csv' ? 'csv' : 'arrow',
    frames: 0,
    domain: [0, 0],
    started: (await stat(input.path)).mtimeMs,
    outputs: [],
    ...(input.contingency && { contingency: input.contingency }),
  }
  const results = new Results(info, kase, cache)
  await readers.use([results], signal, (s) =>
    results.ingest(
      s,
      () => true,
      async () => {},
    ),
  )
  retain(input.uri, results)
  return info
}

async function dispatch(request: Request, signal: AbortSignal): Promise<unknown> {
  switch (request.method) {
    case 'describeSimulation': {
      const result = findRun(request.input.simulationId)
      return summarize(
        result.kase,
        result.info.revision,
        0,
        await diagnoseAsync(result.kase, signal),
      )
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
    case 'runs':
      return (histories.get(request.input.uri) ?? []).map((run) => run.info)
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
      const run = request.input.run ? findRun(request.input.run, request.input.uri) : undefined
      const kase = run?.kase ?? get(request.input).kase
      const query = request.input.query
      const data = run
        ? await run.data(
            query.kind === 'rows' && query.at !== undefined ? [query.at, query.at] : undefined,
            signal,
          )
        : kase.data
      const blocks: QueryBlock[] = []
      for await (const block of read(data, query, {
        signal,
        maxBlockBytes: BLOCK_BYTES,
        buffers: 'owned',
      }))
        blocks.push(block)
      return blocks
    }
    case 'batches': {
      const input = request.input
      const run = request.input.run ? findRun(request.input.run, request.input.uri) : undefined
      const kase = run?.kase ?? get(request.input).kase
      const fields = request.input.fields ?? staticFields(kase.schema)
      const statics = fields
        .map((f) => ({
          ...f,
          select: f.select.filter((name) => !kase.schema.types[f.from]!.fields[name]!.sampled),
        }))
        .filter((f) => f.select.length > 0)
      // One bounded stream for both rows and samples. Freeze its end before yielding to
      // the solver so a growing recording cannot postpone the view's commit indefinitely.
      const endPage = run?.pages.length ?? 0
      // Pages are named by how one reading of the run cut it; another reading cuts it elsewhere.
      if (run && input.paging !== undefined && input.paging !== run.paging)
        throw failure('conflict', 'The run was paged again: its pages are asked for anew.')
      const [firstPage, lastPage] = input.pages
        ? [Math.max(0, input.pages[0]), Math.min(endPage, input.pages[1])]
        : [0, endPage]
      const sampled = fields.filter((f) =>
        f.select.some((name) => kase.schema.types[f.from]?.fields[name]?.sampled),
      )
      const coverage: SampleCoverage[] = []
      if (run && firstPage < lastPage) {
        const first = run.pages[firstPage]!
        const last = run.pages[lastPage - 1]!
        for (const field of sampled)
          for (const name of field.select) {
            if (!kase.schema.types[field.from]?.fields[name]?.sampled) continue
            const table = kase.data.tables[field.from]!
            const rows = intersectRows(
              selectRows(table, field.rows),
              selectRows(table, recordedSelection(kase.data, run.info.outputs, field.from, name)),
            )
            if (rowCount(rows))
              coverage.push({
                from: field.from,
                field: name,
                rows: { ...rows, index: table.index },
                first: first.first,
                count: last.first + last.count - first.first,
                domain: [first.domain[0], last.domain[1]],
              })
          }
      }
      async function* selected(): AsyncGenerator<DataBatch> {
        if (input.includeStatic !== false)
          yield* selectBatches(kase.data, statics, {
            signal,
            maxBlockBytes: BLOCK_BYTES,
            buffers: 'owned',
          })
        if (!run) return
        for (let pages = firstPage; pages < lastPage; pages++) {
          const data = await run.pageData(pages, signal)
          for await (const batch of selectBatches(data, sampled, {
            signal,
            maxBlockBytes: SAMPLE_BLOCK_BYTES,
            buffers: 'owned',
          }))
            if (batch.kind === 'samples') yield batch
        }
      }
      // The next packet is prepared while the view consumes this one.
      await sendAhead(packets(selected(), signal, PACKET_BYTES), (packet) =>
        emit(request.id, packet, signal),
      )
      return { coverage }
    }
    case 'pages': {
      const run = findRun(request.input.run)
      return {
        paging: run.paging,
        pages: run.pages
          .slice(request.input.from)
          .map(({ first, count, domain }) => ({ first, count, domain })),
      }
    }
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
      return findRun(request.input.run).step(request.input.at, request.input.direction)
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
      const results = histories.get(uri) ?? []
      histories.delete(uri)
      for (const result of results) {
        await readers.retire(result)
        result.release()
      }
      return null
    }
    case 'export':
      await findRun(request.input.run).exportCsv(request.input.path, signal)
      return null
    case 'stats':
      return {
        memory: {
          heapUsed: process.memoryUsage().heapUsed,
          arrayBuffers: process.memoryUsage().arrayBuffers,
        },
        cacheBytes: cache.bytes,
        sessions: cases.size,
        runs: [...histories.values()].reduce((n, runs) => n + runs.length, 0),
      }
  }
}

async function handle(request: Request, signal: AbortSignal) {
  const input = request.input
  const targets =
    'run' in input && typeof input.run === 'string'
      ? [findRun(input.run, 'uri' in input ? input.uri : undefined)]
      : []
  try {
    return await readers.use(targets, signal, (s) => dispatch(request, s))
  } finally {
    for (const target of targets)
      if (!histories.get(target.info.revision.uri)?.includes(target)) target.release()
  }
}
port.on('message', (request: ToWorker) => {
  if (request.kind === 'ack') return acknowledgements.get(request.id)?.()
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
          request.method === 'query' ? blockBuffers(value) : [],
        )
      } catch (error) {
        // A value that cannot cross to the extension is a defect, answered as one.
        fail(Object.assign(new Error(message(error)), { defect: true, detail: detail(error) }))
      }
    }, fail)
    .finally(() => operations.delete(request.id))
})
