import { copyFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

import {
  type Arguments,
  blockBuffers,
  type DataBatch,
  type Parameters,
  type QueryBlock,
  read,
  selectBatches,
  staticFields,
} from '@latkit/model'

import { catalogOf } from './gridkit/definition.js'
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
import { aggregate, anchors, neighborhood, selectIds } from './gridkit/inspection.js'
import { analysisLimit, analysisSelection, analyze, compare, snapshot } from './results/analysis.js'
import { Evidence } from './results/findings.js'
import { importedFields, ResultCache, Results } from './results/index.js'
import { Readers } from './results/readers.js'
import { querySignals } from './results/signals.js'
import { ResultStorage } from './results/storage.js'
import { rank, sibling } from './results/study.js'
import type { ResultsTarget } from './shared/analysis.js'
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
import { CaseSnapshots, summarize } from './worker/cases.js'
import { Simulations } from './worker/simulations.js'

const port = parentPort!
const BLOCK_BYTES = 256 << 10
const cases = new Map<string, { kase: Case; summary: Summary }>()
const parses = new Map<string, number>()
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
const ready = storage.initialize()
const snapshots = new CaseSnapshots()
const simulations = new Simulations()
const loading = new Map<
  string,
  { controller: AbortController; done: Promise<Results>; users: number }
>()
let eviction = Promise.resolve()
function trimRecordings(protect?: string, findingsId?: string) {
  eviction = eviction
    .catch(() => {})
    .then(async () => {
      const budget = workerData.storageBytes ?? 4096 * (1 << 20)
      const findingsBytes = await evidence.evict(budget / 8, findingsId)
      return storage.evict(
        Math.max(0, budget - findingsBytes),
        new Set([...simulations.entries.keys(), ...loading.keys(), ...(protect ? [protect] : [])]),
        async (id) => {
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
  return eviction
}
const evidence = new Evidence(join(storage.directory, 'findings'))
async function saveFindings(
  uri: string,
  result: { rows: unknown[] },
  signal: AbortSignal,
  id?: string,
) {
  const saved = await evidence.put(uri, result, signal, id)
  await trimRecordings(undefined, saved)
  return saved
}
const selectionsById = new Map<
  string,
  { uri: string; fingerprint: string; from: string; ids: string[] }
>()
function selected<T extends { selection?: string; ids?: string[]; from: string }>(
  input: T,
  kase: Case,
): T {
  if (!input.selection) return input
  if (input.ids) throw new Error('Choose a selection or explicit IDs, not both.')
  const value = selectionsById.get(input.selection)
  if (!value || value.fingerprint !== kase.version || value.from !== input.from)
    throw new Error(
      'Selection expired or does not match this case content and type. Create a new selection.',
    )
  selectionsById.delete(input.selection)
  selectionsById.set(input.selection, value)
  if (!value.ids.length) throw new Error('The selection is empty.')
  return { ...input, ids: value.ids }
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
  if (revision.snapshotId) return snapshots.get(revision.snapshotId)
  const entry = cases.get(revision.uri)
  if (
    !entry ||
    entry.summary.version !== revision.version ||
    parses.get(revision.uri) !== revision.version ||
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
      const result = new Results(
        { ...record.info, frames: 0, domain: [0, 0] },
        kase,
        selections(kase, record.request.outputs),
        cache,
        storage.path(id),
      )
      try {
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
  if (input.simulationId && storage.records.has(input.simulationId)) {
    const existing = simulations.entries.get(input.simulationId)
    if (!existing || existing.request.uri !== input.uri)
      throw new Error('Simulation identifier is already in use.')
    return existing.info
  }
  const captured = input.snapshotId ? snapshots.get(input.snapshotId) : get(input)
  const { kase } = captured
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
  if (input.snapshotId) snapshots.retain(input.snapshotId)
  simulations.entries.set(id, {
    request,
    kase,
    info,
    controller: new AbortController(),
    snapshotId: input.snapshotId,
  })
  try {
    await storage.create(info, request, kase)
  } catch (error) {
    simulations.entries.delete(id)
    storage.records.delete(id)
    if (input.snapshotId) snapshots.release(input.snapshotId)
    throw error
  }
  send({ kind: 'run', info })
  return info
}

async function stopSimulation(id: string, interrupted = false) {
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
    if (simulation.snapshotId) snapshots.release(simulation.snapshotId)
    simulations.entries.delete(id)
    send({ kind: 'run', info: simulation.info })
  }
}

async function withTarget<T>(
  target: ResultsTarget,
  signal: AbortSignal,
  read: (result: Results) => Promise<T>,
) {
  const current = findRun(target.run, target.uri, true)
  if (target.contingency === undefined || target.contingency === current.info.contingency?.shown)
    return read(current)
  const result = await sibling(current, target.contingency, signal, false)
  try {
    return await read(result)
  } finally {
    result.release()
  }
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
          const evidence = (info.evidence ??= [])
          evidence.push(entry.message.slice(0, 512))
          if (evidence.length > 16) evidence.shift()
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
      info.state = controller.signal.aborted
        ? controller.signal.reason?.interrupted
          ? 'interrupted'
          : 'cancelled'
        : 'failed'
      info.message = message(error)
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
    if (entry.snapshotId) snapshots.release(entry.snapshotId)
  })
  entry.completion = done
  running.set(input.uri, { controller, done })
  return done
}

async function dispatch(request: Request, signal: AbortSignal): Promise<unknown> {
  switch (request.method) {
    case 'captureCase': {
      const captured = snapshots.capture(get(request.input))
      return { snapshotId: captured.snapshotId, fingerprint: captured.kase.version }
    }
    case 'releaseSnapshot':
      snapshots.release(request.input.snapshotId)
      return null
    case 'resolveRecording': {
      const { kase } = snapshots.get(request.input.snapshotId)
      return request.input.recording.map((item) => {
        const resolved = selected(
          {
            from: item.componentType,
            ids: item.componentIds && [...item.componentIds],
            selection: item.selectionId,
          },
          kase,
        )
        return {
          from: item.componentType,
          select: item.fields,
          ...(resolved.ids ? { rows: { kind: 'ids', ids: resolved.ids } } : {}),
        }
      })
    }
    case 'prepareSimulation':
      return prepareSimulation(request.input, signal)
    case 'getSimulation': {
      const info = storage.records.get(request.input.simulationId)?.info
      if (info) return info
      return findRun(request.input.simulationId, undefined, true).info
    }
    case 'describeSimulation': {
      const result = await loadResult(request.input.simulationId, signal)
      return summarize(result.kase, result.info.revision)
    }
    case 'listSimulations': {
      const all = new Map([...storage.records].map(([id, record]) => [id, record.info]))
      for (const results of histories.values())
        for (const result of results)
          if (!all.has(result.info.contingency?.study ?? result.info.id))
            all.set(result.info.id, result.info)
      return [...all.values()]
        .filter((info) => !request.input.uri || info.revision.uri === request.input.uri)
        .sort((a, b) => b.started - a.started)
    }
    case 'stopSimulation':
      await stopSimulation(request.input.simulationId)
      return null
    case 'retainSimulation': {
      const record = storage.records.get(request.input.simulationId)
      if (!record) throw new Error('Unknown simulation.')
      if (request.input.retained && record.info.evicted)
        throw Object.assign(
          new Error('This recording was already evicted; its metadata cannot restore the samples.'),
          { code: 'results-evicted' },
        )
      record.info.retained = request.input.retained
      await storage.save(record.info.id)
      return null
    }
    case 'shutdown':
      await Promise.all([...simulations.entries.keys()].map((id) => stopSimulation(id, true)))
      for (const load of loading.values()) load.controller.abort(new Error('GridKit closed.'))
      await Promise.allSettled([...loading.values()].map((load) => load.done))
      await storage.flush()
      return null
    case 'aggregate':
      return aggregate(get(request.input).kase, request.input, signal)
    case 'neighborhood':
      return neighborhood(get(request.input).kase, request.input, signal)
    case 'anchors':
      return anchors(get(request.input).kase, request.input, signal)
    case 'selection': {
      const { kase } = get(request.input)
      const ids = await selectIds(kase, request.input, signal)
      const selection = crypto.randomUUID()
      selectionsById.set(selection, {
        uri: request.input.uri,
        fingerprint: kase.version,
        from: request.input.from,
        ids,
      })
      while (selectionsById.size > 64) selectionsById.delete(selectionsById.keys().next().value!)
      return {
        selection,
        fingerprint: kase.version,
        from: request.input.from,
        count: ids.length,
        sample: ids.slice(0, 5),
      }
    }
    case 'evidence':
      return evidence.read(request.input.evidence, request.input, signal)
    case 'runs':
      return (histories.get(request.input.uri) ?? []).map((run) => run.info)
    case 'preflight': {
      const { values, command, columns } = preflight(
        get(request.input).kase,
        request.input.values,
        request.input.outputs,
      )
      const runtime = await available(request.input.gridkit, command.program)
      signal.throwIfAborted()
      get(request.input)
      return {
        values,
        program: command.program,
        domain: command.domain,
        scenarios: command.program === 'ContingencyAnalysis' ? command.faults.length : 1,
        columns,
        runtime: runtime.kind,
      }
    }
    case 'analyze':
      return withTarget(request.input, signal, async (run) => {
        const result = await analyze(run, selected(request.input, run.kase), signal)
        result.evidence = await saveFindings(
          request.input.uri,
          result,
          signal,
          request.input.analysisId,
        )
        result.rows = result.rows.slice(0, analysisLimit(request.input.limit))
        return result
      })
    case 'validateResults':
      return withTarget(request.input, signal, async (result) => {
        const { window } = analysisSelection(result, request.input)
        if (!result.info.frames) throw new Error('This simulation has no recorded samples yet.')
        if (window[0] < result.info.domain[0] || window[1] > result.info.domain[1])
          throw new Error('Choose a time range within the recorded interval.')
        return null
      })
    case 'signals':
      return withTarget(request.input, signal, (run) => querySignals(run, request.input, signal))
    case 'compare': {
      const input = request.input
      return withTarget(input.before, signal, (before) =>
        withTarget(input.after, signal, async (after) => {
          const left = snapshot(before)
          const right = snapshot(after)
          const window = input.window ?? [
            Math.max(left.info.domain[0], right.info.domain[0]),
            Math.min(left.info.domain[1], right.info.domain[1]),
          ]
          if (
            window[0] > window[1] ||
            window[0] < Math.max(left.info.domain[0], right.info.domain[0]) ||
            window[1] > Math.min(left.info.domain[1], right.info.domain[1])
          )
            throw new Error('Comparison needs an interval covered by both simulations.')
          const options = { ...input, window: window as readonly [number, number] }
          const result = compare(
            await analyze(before, selected(options, before.kase), signal, left),
            await analyze(after, selected(options, after.kase), signal, right),
            Number.MAX_SAFE_INTEGER,
          )
          result.evidence = await saveFindings(input.after.uri, result, signal, input.analysisId)
          result.rows = result.rows.slice(0, analysisLimit(input.limit))
          return result
        }),
      )
    }
    case 'rank': {
      const run = findRun(request.input.run, request.input.uri, true)
      const result = await rank(
        run,
        { ...selected(request.input, run.kase), limit: Number.MAX_SAFE_INTEGER },
        signal,
      )
      result.evidence = await saveFindings(
        request.input.uri,
        result,
        signal,
        request.input.analysisId,
      )
      result.rows = result.rows.slice(0, analysisLimit(request.input.limit))
      return result
    }
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
      parses.set(uri, version)
      attachments.set(uri, attachmentId)
      const started = performance.now()
      const kase = await Case.parse(text, catalog, uri.split('/').at(-1), signal)
      signal.throwIfAborted()
      if (parses.get(uri) !== version || attachments.get(uri) !== attachmentId)
        throw new Error('Superseded document revision.')
      const summary = summarize(kase, { uri, version, attachmentId }, performance.now() - started)
      cases.set(uri, { kase, summary })
      return summary
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
      const run = request.input.run ? findRun(request.input.run, request.input.uri) : undefined
      const kase = run?.kase ?? get(request.input).kase
      const fields = request.input.fields ?? staticFields(kase.schema)
      const statics = fields
        .map((f) => ({
          ...f,
          select: f.select.filter((name) => !kase.schema.types[f.from]!.fields[name]!.sampled),
        }))
        .filter((f) => f.select.length > 0)
      if (request.input.includeStatic !== false)
        for await (const batch of selectBatches(kase.data, statics, {
          signal,
          maxBlockBytes: BLOCK_BYTES,
          buffers: 'owned',
        }))
          await emit(request.id, [batch], signal)
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
            if (batch.kind === 'samples') await emit(request.id, [batch], signal)
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
      const { shown } = request.input
      const next = await readers.use([ownerOf(current)], signal, async (s) => {
        const loaded = await sibling(current, shown, s, true)
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
      await storage.create(
        info,
        { ...request.input, values: {}, outputs, gridkit: { path: '', image: '', cli: '' } },
        kase,
      )
      await copyFile(originalPath, info.path)
      // Results that fail to read take no run's place: the import fails, and the case's runs stay.
      const result = new Results(
        info,
        kase,
        selections(kase, outputs),
        cache,
        storage.path(info.id),
      )
      try {
        await readers.use([ownerOf(result)], signal, (s) =>
          result.ingest(
            s,
            () => true,
            async () => {},
          ),
        )
      } catch (error) {
        info.state = signal.aborted ? 'cancelled' : 'failed'
        info.message = message(error)
        await discard(result)
        throw error
      }
      info.state = 'complete'
      await storage.save(info.id)
      await retain(request.input.uri, result)
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
  await ready
  const input = request.input
  if (request.method === 'compare') {
    await loadResult(request.input.before.run, signal)
    await loadResult(request.input.after.run, signal)
  } else if ('run' in input && typeof input.run === 'string') await loadResult(input.run, signal)
  const analysis =
    request.method === 'analyze' ||
    request.method === 'validateResults' ||
    request.method === 'compare' ||
    request.method === 'rank' ||
    request.method === 'signals'
  const targets =
    request.method === 'compare'
      ? [
          findRun(request.input.before.run, request.input.before.uri, true),
          findRun(request.input.after.run, request.input.after.uri, true),
        ]
      : request.method !== 'contingency' && 'run' in input && typeof input.run === 'string'
        ? [findRun(input.run, 'uri' in input ? input.uri : undefined, analysis)]
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
      message: message(error),
      code:
        typeof (error as { code?: unknown } | null)?.code === 'string'
          ? (error as { code: string }).code
          : undefined,
      offset: (error as { offset?: number } | null)?.offset,
      length: (error as { length?: number } | null)?.length,
      issues: (error as { issues?: unknown } | null)?.issues,
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
