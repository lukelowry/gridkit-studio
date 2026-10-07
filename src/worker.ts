import { copyFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import {
  type Arguments,
  blockBuffers,
  type DataBatch,
  failure,
  type Parameters,
  type QueryBlock,
  read,
  rowCount,
  selectBatches,
  selectRows,
  staticFields,
} from '@latkit/model'

import { catalogOf } from './gridkit/definition.js'
import { diagnoseAsync } from './gridkit/edits.js'
import {
  applyChanges,
  available,
  Case,
  catalog,
  completionsAt,
  preflight,
  presentation,
  selections,
  Simulation,
  sourceContext,
  sourceRange,
  transaction,
} from './gridkit/index.js'
import { anchors } from './gridkit/inspection.js'
import { solverLine } from './gridkit/solver.js'
import { importedFields, PROGRESS_MS, ResultCache, Results } from './results/index.js'
import { Readers } from './results/readers.js'
import { ResultStorage } from './results/storage.js'
import { sibling } from './results/study.js'
import {
  intersectRows,
  pageWindow,
  recordedSelection,
  type SampleCoverage,
} from './shared/coverage.js'
import { failureOf } from './shared/errors.js'
import { defect, detail, message } from './shared/format.js'
import type {
  FromWorker,
  Request,
  Revision,
  SimulationInfo,
  SimulationRequest,
  Summary,
  ToWorker,
} from './shared/messages.js'
import { nameFieldOf } from './shared/schema.js'
import { packets, sendAhead } from './worker/batches.js'
import { CaseCache, summarize } from './worker/cases.js'
import { Simulations } from './worker/simulations.js'

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
const running = new Map<string, { controller: AbortController; done: Promise<unknown> }>()
const histories = new Map<string, Results[]>()
const readers = new Readers<object>()
/** Contingencies share a directory lifetime even when the displayed Results object changes. */
const owners = new Map<string, object>()
const ownerOf = (run: Results): object => {
  if (!run.ownedDirectory) return run
  let owner = owners.get(run.ownedDirectory)
  if (!owner) {
    owner = {}
    owners.set(run.ownedDirectory, owner)
  }
  return owner
}
/** Releases `run` and deletes its folder. A folder that cannot be deleted yet, as Windows refuses
 *  while another program holds a file in it, is logged and left for the next start to sweep: it
 *  never fails the run or request that let it go. */
async function discard(run: Results) {
  try {
    await readers.retire(ownerOf(run))
    const id = run.info.contingency?.study ?? run.info.id
    if (storage.records.has(id)) {
      run.release()
      await storage.removeRecording(id)
    } else await run.dispose(scratch)
  } catch (error) {
    send({
      kind: 'log',
      level: 'warn',
      message: `Could not delete the files of run ${run.info.id}: ${message(error)}`,
    })
  } finally {
    if (run.ownedDirectory) owners.delete(run.ownedDirectory)
  }
}
const cache = new ResultCache()
const scratch = workerData.scratch as string
const storage = new ResultStorage(workerData.storage ?? join(scratch, 'retained'))
const simulations = new Simulations()
const loading = new Map<
  string,
  { controller: AbortController; done: Promise<Results>; users: number }
>()
let eviction = Promise.resolve()
let queuedEviction: Promise<void> | undefined
const protectedRecordings = new Set<string>()
function trimRecordings(protect?: string) {
  if (protect) protectedRecordings.add(protect)
  if (queuedEviction) return queuedEviction
  const next = eviction
    .then(async () => {
      queuedEviction = undefined
      const budget = workerData.storageBytes ?? 4096 * (1 << 20)
      return storage.evict(
        budget,
        new Set([...simulations.entries.keys(), ...loading.keys(), ...protectedRecordings]),
        async (id) => {
          if (protectedRecordings.has(id) || simulations.entries.has(id) || loading.has(id))
            return false
          const loaded = [...histories.values()]
            .flat()
            .filter((result) => (result.info.contingency?.study ?? result.info.id) === id)
          if (loaded.some((result) => readers.busy(ownerOf(result)))) return false
          for (const result of loaded) {
            const values = histories.get(result.info.revision.uri)!
            values.splice(values.indexOf(result), 1)
            await readers.retire(ownerOf(result))
            result.release()
            if (result.ownedDirectory) owners.delete(result.ownedDirectory)
          }
          return true
        },
      )
    })
    .catch((error) => {
      send({
        kind: 'log',
        level: 'warn',
        message: `Result cleanup will be retried: ${message(error)}`,
      })
    })
  eviction = queuedEviction = next
  void next.then(() => {
    if (eviction === next) {
      protectedRecordings.clear()
    }
  })
  return next
}
let recordingsReady: Promise<void> | undefined
function ensureRecordingsReady(): Promise<void> {
  return (recordingsReady ??= storage.initialize().catch((error) => {
    recordingsReady = undefined
    throw error
  }))
}
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
    throw new Error('The document changed. Wait for the current revision.')
  return entry
}
const findRun = (id: string, uri?: string, allowStudy = false) => {
  for (const [key, runs] of histories) {
    if (uri !== undefined && key !== uri) continue
    const run = runs.find(
      (run) => run.info.id === id || (allowStudy && run.info.contingency?.study === id),
    )
    if (run) return run
  }
  throw Object.assign(new Error('No recording is available for this simulation.'), {
    code: 'results-unavailable',
    simulationId: id,
  })
}

async function loadResult(id: string, signal: AbortSignal): Promise<Results> {
  await ensureRecordingsReady()
  signal.throwIfAborted()
  try {
    return findRun(id, undefined, true)
  } catch {
    /* Load retained recordings on demand. */
  }
  let pending = loading.get(id)
  if (!pending) {
    const controller = new AbortController()
    const signal = controller.signal
    const done = (async () => {
      const record = storage.records.get(id)
      if (!record || !(await storage.available(id)))
        throw Object.assign(new Error('This simulation has no retained recording.'), {
          code: record?.info.evicted ? 'results-evicted' : 'results-unavailable',
          simulationId: id,
        })
      const kase = await Case.parse(
        await storage.source(id),
        catalogOf(await storage.catalog(id)),
        record.info.name,
        signal,
      )
      if (kase.version !== record.info.fingerprint)
        throw new Error('The retained case fingerprint does not match its recording.')
      const saved = record.info
      const fields = selections(kase, record.request.outputs)
      const open = () =>
        new Results({ ...saved, frames: 0, domain: [0, 0] }, kase, fields, cache, storage.path(id))
      let result = open()
      try {
        // The run measured its domains as it ran, so reading back its times pages it, unless the
        // file holds frames they never saw, as a stopped run's last rows may be.
        let measured = false
        if (saved.domains) {
          await result.index(signal)
          const { frames, domain } = result.info
          measured =
            frames === saved.frames &&
            domain[0] === saved.domain[0] &&
            domain[1] === saved.domain[1]
          if (measured) result.info.domains = saved.domains
          else result = open()
        }
        if (!measured)
          await result.ingest(
            signal,
            () => true,
            async () => {},
          )
        await retain(record.info.revision.uri, result)
        return result
      } catch (error) {
        result.release()
        throw error
      }
    })().finally(() => {
      if (loading.get(id)?.done === done) loading.delete(id)
    })
    pending = { controller, done, users: 0 }
    loading.set(id, pending)
  }
  const load = pending
  load.users++
  // Each consumer leaves independently; only the last cancelled consumer aborts decoding.
  let abort!: () => void
  return new Promise<Results>((resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    load.done.then(resolve, reject)
  }).finally(() => {
    signal.removeEventListener('abort', abort)
    if (--load.users === 0 && loading.get(id) === load) {
      loading.delete(id)
      load.controller.abort(new Error('No consumers remain for this recording.'))
    }
  })
}

async function prepareSimulation(input: SimulationRequest, signal: AbortSignal) {
  await ensureRecordingsReady()
  if (input.simulationId && storage.records.has(input.simulationId)) {
    const existing = simulations.entries.get(input.simulationId)
    if (!existing || existing.request.uri !== input.uri)
      throw new Error('Simulation identifier is already in use.')
    return existing.info
  }
  const { kase } = get(input)
  await diagnoseAsync(kase, signal)
  if (get(input).kase !== kase) throw new Error('The document changed. Refresh before running.')
  const checked = preflight(kase, input.values, input.outputs)
  await available(input.gridkit, checked.command.program)
  signal.throwIfAborted()
  if (simulations.active(input.uri))
    throw Object.assign(new Error('A simulation is already active for this case.'), {
      code: 'simulation-active',
    })
  const id = input.simulationId ?? crypto.randomUUID()
  const info: SimulationInfo = {
    id,
    revision: { uri: input.uri, version: input.version },
    fingerprint: kase.version,
    name: kase.name,
    state: 'preparing',
    path: join(storage.path(id), 'results.csv'),
    format: 'csv',
    frames: 0,
    domain: [0, 0],
    started: Date.now(),
    outputs: input.outputs,
    span: checked.command.domain,
    configuration: {
      values: checked.values,
      program: checked.command.program,
      options: checked.command.options.map(({ option, value }) => ({ name: option.id, value })),
      addedFaults: structuredClone(checked.command.faults),
    },
  }
  const request = { ...input, simulationId: id, values: checked.values }
  simulations.entries.set(id, {
    request,
    kase,
    info,
    controller: new AbortController(),
  })
  try {
    await storage.create(info, request, kase)
  } catch (error) {
    simulations.entries.delete(id)
    throw error
  }
  send({ kind: 'run', info })
  return info
}

async function stopSimulation(id: string, interrupted = false) {
  await ensureRecordingsReady()
  const simulation = simulations.entries.get(id)
  if (!simulation) {
    const record = storage.records.get(id)
    if (!record)
      throw Object.assign(new Error('Unknown simulation.'), { code: 'simulation-not-found' })
    if (['preparing', 'running'].includes(record.info.state))
      throw Object.assign(
        new Error('This simulation belongs to another VS Code window. Stop it in that window.'),
        { code: 'simulation-owner-unavailable' },
      )
    return
  }
  simulation.controller.abort(
    Object.assign(
      new Error(
        interrupted
          ? 'The extension stopped before this simulation completed.'
          : 'Simulation cancelled.',
      ),
      { interrupted },
    ),
  )
  if (simulation.completion) await simulation.completion
  else {
    simulation.info.state = interrupted ? 'interrupted' : 'cancelled'
    simulation.info.message = simulation.controller.signal.reason.message
    await storage.save(id)
    simulations.entries.delete(id)
    send({ kind: 'run', info: simulation.info })
  }
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
/** Decoded data is bounded by ResultCache; recordings have a separate disk lifetime. */
async function retain(uri: string, run: Results) {
  const runs = histories.get(uri) ?? []
  runs.unshift(run)
  histories.set(uri, runs)
  const loaded = [...histories.values()].flat().sort((a, b) => a.info.started - b.info.started)
  for (const old of loaded.slice(0, Math.max(0, loaded.length - 8))) {
    if (
      old === run ||
      old.info.state === 'running' ||
      readers.busy(ownerOf(old)) ||
      !storage.records.has(old.info.contingency?.study ?? old.info.id)
    )
      continue
    const values = histories.get(old.info.revision.uri)!
    values.splice(values.indexOf(old), 1)
    old.release()
  }
}

async function runCase(input: SimulationRequest) {
  const prepared = input.simulationId ? simulations.entries.get(input.simulationId) : undefined
  const stopped = input.simulationId && storage.records.get(input.simulationId)?.info
  if (!prepared && stopped && !['preparing', 'running'].includes(stopped.state)) return stopped
  const info = prepared?.info ?? (await prepareSimulation(input, new AbortController().signal))
  const entry = simulations.get(info.id)
  if (entry.completion) return entry.completion
  const { kase, controller } = entry
  input = entry.request
  cache.limit = cacheLimit(input.cacheBytes)
  const done = (async () => {
    const directory = storage.path(info.id)
    info.state = 'running'
    const simulation = new Simulation(kase, input, directory, cache, info, (process) =>
      send({ kind: 'process', uri: input.uri, process }),
    )
    let lastProgress = 0
    let logWindow = 0
    let logCount = 0
    let dropped = 0
    /** Whether GridKit has said why the run stops; the errors after restate it as it unwinds. */
    let said = false
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
          if (performance.now() - lastProgress > PROGRESS_MS) {
            send({ kind: 'run', info })
            lastProgress = performance.now()
          }
        },
        // Each line in plain words at its level, at most 100 a second; the rest are counted, and the
        // count sent.
        log: (entry) => {
          const line = solverLine(entry.message, input.values.program, said)
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
      })
      info.state = 'complete'
    } catch (error) {
      info.state = controller.signal.aborted
        ? controller.signal.reason?.interrupted
          ? 'interrupted'
          : 'cancelled'
        : 'failed'
      info.message = message(error)
      const at = (error as { at?: unknown } | null)?.at
      if (typeof at === 'number') info.failedAt = at
      if (defect(error)) send({ kind: 'log', level: 'error', message: detail(error) })
    } finally {
      // The run's last state goes out whatever its cleanup meets, so it never stays running.
      try {
        if (simulation.results && !retained) await retain(input.uri, simulation.results)
        await storage.save(info.id)
        await trimRecordings(info.id)
      } finally {
        send({ kind: 'run', info })
      }
    }
    return info
  })().finally(() => {
    running.delete(input.uri)
    simulations.entries.delete(info.id)
  })
  entry.completion = done
  running.set(input.uri, { controller, done })
  return done
}

async function dispatch(request: Request, signal: AbortSignal): Promise<unknown> {
  switch (request.method) {
    case 'prepareSimulation':
      return prepareSimulation(request.input, signal)
    case 'getSimulation': {
      await ensureRecordingsReady()
      const info = storage.records.get(request.input.simulationId)?.info
      if (info) return info
      return findRun(request.input.simulationId, undefined, true).info
    }
    case 'describeSimulation': {
      const result = await loadResult(request.input.simulationId, signal)
      return summarize(
        result.kase,
        result.info.revision,
        0,
        await diagnoseAsync(result.kase, signal),
      )
    }
    case 'stopSimulation':
      await stopSimulation(request.input.simulationId)
      return null
    case 'shutdown':
      await recordingsReady
      await Promise.all([...simulations.entries.keys()].map((id) => stopSimulation(id, true)))
      for (const load of loading.values()) load.controller.abort(new Error('GridKit closed.'))
      await Promise.allSettled([...loading.values()].map((load) => load.done))
      await eviction
      await storage.flush()
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
      const [firstPage, lastPage] = pageWindow(
        run?.pages ?? [],
        input.window,
        input.fromPage ?? 0,
        endPage,
      )
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
      const last = run?.pages[endPage - 1]
      return { pages: endPage, frames: last ? last.first + last.count : 0, coverage }
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
    case 'step':
      return findRun(request.input.run).step(request.input.at, request.input.direction)
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
      const { shown } = request.input
      const next = await readers.use([ownerOf(current)], signal, async (s) => {
        const loaded = await sibling(current, shown, s)
        const runs = [...histories.values()].find((runs) => runs.includes(current))
        if (s.aborted || !runs) {
          loaded.release()
          throw new Error('The recording was cleared or replaced.')
        }
        runs[runs.indexOf(current)] = loaded
        return loaded
      })
      const info = next.info
      current.release()
      send({ kind: 'run', info })
      return info
    }
    case 'stop': {
      const active = simulations.active(request.input.uri)
      if (active) await stopSimulation(active.info.id)
      return null
    }
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
      await ensureRecordingsReady()
      const uri = request.input.uri
      const active = simulations.active(uri)
      if (active) await stopSimulation(active.info.id)
      const results = histories.get(uri) ?? []
      histories.delete(uri)
      for (const result of results) await discard(result)
      for (const [id, record] of storage.records) {
        if (
          record.info.revision.uri !== uri ||
          record.info.evicted ||
          ['preparing', 'running'].includes(record.info.state)
        )
          continue
        await storage.removeRecording(id)
      }
      return null
    }
    case 'import': {
      await ensureRecordingsReady()
      const { kase } = get(request.input)
      cache.limit = cacheLimit(request.input.cacheBytes)
      const format = request.input.path.endsWith('.csv') ? 'csv' : 'arrow'
      const outputs = await importedFields(kase, request.input.path, format, signal)
      const info: SimulationInfo = {
        id: crypto.randomUUID(),
        revision: { uri: request.input.uri, version: request.input.version },
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
      const originalPath = info.path
      info.path = join(storage.path(info.id), 'results.' + format)
      let result: Results | undefined
      try {
        await storage.create(
          info,
          { ...request.input, values: {}, outputs, gridkit: { path: '', image: '', cli: '' } },
          kase,
        )
        await copyFile(originalPath, info.path)
        signal.throwIfAborted()
        const imported = (result = new Results(
          info,
          kase,
          selections(kase, outputs),
          cache,
          storage.path(info.id),
        ))
        await readers.use([ownerOf(imported)], signal, (s) =>
          imported.ingest(
            s,
            () => true,
            async () => {},
          ),
        )
        info.state = 'complete'
        await storage.save(info.id)
        await retain(request.input.uri, imported)
      } catch (error) {
        info.state = signal.aborted ? 'cancelled' : 'failed'
        info.message = message(error)
        if (result) await discard(result)
        else
          await storage.removeRecording(info.id).catch((cleanupError) => {
            send({
              kind: 'log',
              level: 'warn',
              message: `Import cleanup will be retried: ${message(cleanupError)}`,
            })
          })
        throw error
      }
      await trimRecordings(info.id)
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

async function handle(request: Request, signal: AbortSignal) {
  const input = request.input
  if ('run' in input && typeof input.run === 'string') await loadResult(input.run, signal)
  const targets =
    request.method !== 'contingency' && 'run' in input && typeof input.run === 'string'
      ? [findRun(input.run, 'uri' in input ? input.uri : undefined)]
      : []
  try {
    return await readers.use(targets.map(ownerOf), signal, (s) => dispatch(request, s))
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
