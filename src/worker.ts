import { mkdir, mkdtemp } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import {
  type Arguments,
  blockBuffers,
  blockByteLength,
  type DataBatch,
  type Parameters,
  type QueryBlock,
  read,
  selectBatches,
  staticFields,
} from '@latkit/model'

import {
  applyChanges,
  Case,
  catalog,
  completionsAt,
  contingencyFile,
  diagnose,
  editable,
  parametersOf,
  placement,
  presentation,
  selections,
  Simulation,
  sourceContext,
  sourceRange,
  transaction,
} from './gridkit/index.js'
import { importedFields, ResultCache, Results } from './results/index.js'
import { message } from './shared/format.js'
import type {
  FromWorker,
  Request,
  Revision,
  RunInfo,
  RunRequest,
  Summary,
  ToWorker,
} from './shared/messages.js'
import { nameFieldOf } from './shared/schema.js'

const port = parentPort!
const BLOCK_BYTES = 256 << 10
const cases = new Map<string, { kase: Case; summary: Summary }>()
const parses = new Map<string, number>()
const mirrors = new Map<string, { version: number; text: string }>()
const operations = new Map<number, AbortController>()
const acknowledgements = new Map<number, () => void>()
const running = new Map<string, { controller: AbortController; done: Promise<unknown> }>()
const histories = new Map<string, Results[]>()
const cache = new ResultCache()
const scratch = workerData.scratch as string
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
    parses.get(revision.uri) !== revision.version
  )
    throw new Error('The document changed. Wait for the current revision.')
  return entry
}
const findRun = (id: string) => {
  for (const runs of histories.values()) {
    const run = runs.find((run) => run.info.id === id)
    if (run) return run
  }
  throw new Error('The run is no longer open.')
}
/** Sends `batches` for request `id`; resolves once the view acknowledges them. */
async function emit(id: number, batches: readonly DataBatch[], signal: AbortSignal) {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('View stopped consuming data.'))
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
/** Keeps `run` as the case's newest, disposing all but its two newest runs. */
async function retain(uri: string, run: Results) {
  const runs = histories.get(uri) ?? []
  runs.unshift(run)
  histories.set(uri, runs)
  while (runs.length > 2) await runs.pop()!.dispose(scratch)
}

function runCase(input: RunRequest) {
  const { kase } = get(input)
  if (running.has(input.uri)) throw new Error('A run is still executing or cleaning up.')
  cache.limit = cacheLimit(input.cacheBytes)

  const controller = new AbortController()
  const done = (async () => {
    await mkdir(scratch, { recursive: true })
    const directory = await mkdtemp(join(scratch, 'run-'))
    const info: RunInfo = {
      id: crypto.randomUUID(),
      revision: { uri: input.uri, version: input.version },
      fingerprint: kase.version,
      name: kase.name,
      state: 'running',
      path: join(directory, 'results.csv'),
      format: 'csv',
      frames: 0,
      domain: [0, 0],
      started: Date.now(),
      outputs: input.outputs,
    }
    const simulation = new Simulation(kase, input, directory, cache, info, (process) =>
      send({ kind: 'process', uri: input.uri, process }),
    )
    let lastProgress = 0
    let logWindow = 0
    let logCount = 0
    let dropped = 0
    let retained = false
    try {
      send({ kind: 'run', info })
      await simulation.run(input.values as Arguments<Parameters>, {
        signal: controller.signal,
        outputs: input.outputs,
        maxBlockBytes: BLOCK_BYTES,
        publish: async () => {
          if (!retained && simulation.results) {
            await retain(input.uri, simulation.results)
            retained = true
          }
        },
        progress: () => {
          if (performance.now() - lastProgress > 100) {
            send({ kind: 'run', info })
            lastProgress = performance.now()
          }
        },
        // At most 100 lines a second; the rest are counted, and the count sent.
        log: (entry) => {
          if (Date.now() - logWindow > 1000) {
            if (dropped)
              send({
                kind: 'log',
                uri: input.uri,
                message: `${dropped} solver log lines omitted.`,
              })
            dropped = 0
            logWindow = Date.now()
            logCount = 0
          }
          if (++logCount <= 100) send({ kind: 'log', uri: input.uri, message: entry.message })
          else dropped++
        },
      })
      info.state = 'complete'
    } catch (error) {
      info.state = controller.signal.aborted ? 'cancelled' : 'failed'
      info.message = message(error)
    } finally {
      if (!retained && simulation.results) await retain(input.uri, simulation.results)
      // Without results, nothing else deletes the run's folder.
      if (!simulation.results) await new Results(info, kase, [], cache, directory).dispose(scratch)
      send({ kind: 'run', info })
    }
    return info
  })().finally(() => running.delete(input.uri))
  running.set(input.uri, { controller, done })
  return done
}

async function handle(request: Request, signal: AbortSignal): Promise<unknown> {
  switch (request.method) {
    case 'placement':
      return placement(get(request.input).kase, signal)
    case 'parse': {
      const { uri, version } = request.input
      const previous = mirrors.get(uri)
      if (!('text' in request.input) && previous?.version !== request.input.baseVersion)
        throw new Error('Source mirror is stale.')
      const text =
        'text' in request.input
          ? request.input.text
          : applyChanges(previous!.text, request.input.changes)
      mirrors.set(uri, { version, text })
      parses.set(uri, version)
      const started = performance.now()
      const kase = await Case.parse(text, catalog, uri.split('/').at(-1), signal)
      signal.throwIfAborted()
      if (parses.get(uri) !== version) throw new Error('Superseded document revision.')
      const summary: Summary = {
        editable: Object.fromEntries(
          [...kase.tables].map(([type, { shape }]) => [
            type,
            [...shape.plan.values()].filter(editable).map((plan) => plan.name),
          ]),
        ),
        uri,
        version,
        name: kase.name,
        fingerprint: kase.version,
        schema: kase.schema,
        identities: Object.fromEntries(
          [...kase.tables].map(([type, { shape }]) => [type, shape.identity.name]),
        ),
        counts: Object.fromEntries(
          [...kase.tables].map(([type, table]) => [type, table.starts.at(-1)!]),
        ),
        parameters: parametersOf(catalog),
        issues: diagnose(kase),
        parseMs: performance.now() - started,
      }
      cases.set(uri, { kase, summary })
      return summary
    }
    case 'query': {
      const { kase } = get(request.input)
      const query = request.input.query
      if (
        query.kind === 'rows' &&
        (query.limit === undefined || query.limit > 100 || query.limit < 0)
      )
        throw new Error('Queries are limited to 100 rows.')
      const data = request.input.run
        ? await findRun(request.input.run).data(
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
      const run = request.input.run ? findRun(request.input.run) : undefined
      const kase = run?.kase ?? get(request.input).kase
      const fields = request.input.fields ?? staticFields(kase.schema)
      const statics = fields
        .map((f) => ({
          ...f,
          select: f.select.filter((name) => !kase.schema.types[f.from]!.fields[name]!.sampled),
        }))
        .filter((f) => f.select.length > 0)
      const maxBytes = request.input.maxBytes ?? 64 << 20
      let sentBytes = 0
      const bounded = async (batch: DataBatch) => {
        sentBytes += blockByteLength(batch)
        if (sentBytes > maxBytes)
          throw new Error(
            `Visible data exceeds ${maxBytes >> 20} MiB. Narrow the time window or select fewer signals.`,
          )
        await emit(request.id, [batch], signal)
      }
      if (request.input.includeStatic !== false)
        for await (const batch of selectBatches(kase.data, statics, {
          signal,
          maxBlockBytes: BLOCK_BYTES,
          buffers: 'owned',
        }))
          await bounded(batch)
      // Pages are immutable once published: a view that holds the first of them asks for the rest.
      let pages = request.input.fromPage ?? 0
      if (run) {
        const sampled = fields.filter((f) =>
          f.select.some((name) => kase.schema.types[f.from]?.fields[name]?.sampled),
        )
        const window = request.input.window
        for (; pages < run.pages.length; pages++) {
          const page = run.pages[pages]!
          if (window && (page.domain[1] < window[0] || page.domain[0] > window[1])) continue
          const data = await run.pageData(pages, signal)
          for await (const batch of selectBatches(data, sampled, {
            signal,
            maxBlockBytes: BLOCK_BYTES,
            buffers: 'owned',
          }))
            if (batch.kind === 'samples') await bounded(batch)
        }
      }
      return { pages }
    }
    case 'elements': {
      const { kase } = get(request.input)
      const table = kase.tables.get(request.input.type)
      if (!table) return []
      const named = nameFieldOf(kase.schema, request.input.type)
      return Array.from({ length: table.records.length }, (_, row) => {
        const name = named === null ? null : kase.cell(table, named, row)
        return { id: kase.id(table, row), name: typeof name === 'string' ? name : '' }
      })
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
    case 'step': {
      const run = findRun(request.input.run)
      const { at, direction } = request.input
      const forward = direction > 0
      for (const page of forward ? run.pages : [...run.pages].reverse()) {
        if (forward ? page.domain[1] <= at : page.domain[0] >= at) continue
        const times = await run.times(page, signal)
        const next = forward ? times.find((time) => time > at) : times.findLast((time) => time < at)
        if (next !== undefined) return next
      }
      return forward ? run.info.domain[1] : run.info.domain[0]
    }
    case 'transact':
      return transaction(get(request.input).kase, request.input.mutations)
    case 'presentation':
      return presentation(get(request.input).kase)
    case 'locate':
      return sourceRange(get(request.input).kase, request.input.id, request.input.field)
    case 'run':
      return runCase(request.input)
    case 'contingency': {
      const current = findRun(request.input.run)
      const study = current.info.contingency
      const { shown } = request.input
      if (!study || !Number.isInteger(shown) || shown < 0 || shown >= study.buses.length)
        throw new Error('The run has no such contingency.')
      if (study.failed.includes(shown))
        throw new Error('That contingency failed; it has no results.')
      const info: RunInfo = {
        ...current.info,
        id: crypto.randomUUID(),
        path: join(dirname(current.info.path), contingencyFile(study.offset + shown)),
        frames: 0,
        domain: [0, 0],
        contingency: { ...study, shown },
      }
      const next = new Results(info, current.kase, current.fields, cache, current.ownedDirectory)
      await next.ingest(
        signal,
        () => true,
        async () => {},
      )
      // The contingency takes its study's place among the runs, and the study's folder with it.
      for (const runs of histories.values()) {
        const at = runs.indexOf(current)
        if (at >= 0) runs[at] = next
      }
      current.release()
      send({ kind: 'run', info })
      return info
    }
    case 'stop': {
      const run = running.get(request.input.uri)
      run?.controller.abort(new Error('Simulation cancelled.'))
      await run?.done
      return null
    }
    case 'clear':
    case 'release': {
      const uri = request.input.uri
      const run = running.get(uri)
      run?.controller.abort(new Error('Case closed.'))
      await run?.done
      for (const result of histories.get(uri) ?? []) await result.dispose(scratch)
      histories.delete(uri)
      if (request.method === 'release') {
        cases.delete(uri)
        parses.delete(uri)
        mirrors.delete(uri)
      }
      return null
    }
    case 'import': {
      const { kase } = get(request.input)
      cache.limit = cacheLimit(request.input.cacheBytes)
      const format = request.input.path.endsWith('.csv') ? 'csv' : 'arrow'
      const outputs = await importedFields(kase, request.input.path, format, signal)
      const info: RunInfo = {
        id: crypto.randomUUID(),
        revision: request.input,
        fingerprint: kase.version,
        name: basename(request.input.path),
        state: 'running',
        path: request.input.path,
        format,
        frames: 0,
        domain: [0, 0],
        started: Date.now(),
        outputs,
      }
      const result = new Results(info, kase, selections(kase, outputs), cache)
      await retain(request.input.uri, result)
      try {
        await result.ingest(
          signal,
          () => true,
          async () => {},
        )
        info.state = 'complete'
      } catch (error) {
        info.state = 'failed'
        info.message = String(error)
      }
      send({ kind: 'run', info })
      return info
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
port.on('message', (request: ToWorker) => {
  if (request.kind === 'ack') return acknowledgements.get(request.id)?.()
  if (request.kind === 'cancel') return operations.get(request.id)?.abort(new Error('Cancelled'))
  const controller = new AbortController()
  operations.set(request.id, controller)
  void handle(request, controller.signal)
    .then(
      (value) =>
        send(
          { kind: 'result', id: request.id, value },
          request.method === 'query' ? blockBuffers(value) : [],
        ),
      (error) =>
        send({
          kind: 'error',
          id: request.id,
          message: message(error),
          offset: error?.offset,
          length: error?.length,
        }),
    )
    .finally(() => operations.delete(request.id))
})
