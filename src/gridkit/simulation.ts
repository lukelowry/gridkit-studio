/** One run of GridKit on a solver file, in its folder, as a shell runs it. A DynamicSimulation is
 *  read while it writes its output. A ContingencyAnalysis shows the first contingency it wrote once
 *  it ends. */

import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { described, type ResultCache, ResultsFile } from '../results/index.js'
import type { Run, RuntimeProcess, SimulationRequest, Study } from '../shared/simulation.js'
import { contingencyFile } from '../shared/study.js'
import type { Case } from './case.js'
import { launch } from './runtime.js'

export interface RunContext {
  readonly signal: AbortSignal
  /** Hears of each results file the run reads, as soon as it reads it, so views can ask it for
   *  frames as it fills. */
  readonly reading: (file: ResultsFile) => void
  /** Hears of each run of frames read. */
  readonly progress: () => Promise<void>
  readonly log: (message: string) => void
  readonly lifecycle?: (process?: RuntimeProcess) => void
}

/** The bus each contingency of a study of `kase` faults, in GridKit's order. Until ORNL/GridKit#611
 *  GridKit faults each BusFault device of the case in turn; since, a case has none, and it faults
 *  each bus. */
function contingencyBuses(kase: Case): number[] {
  const buses = kase.table(kase.catalog.bus)
  const faults = kase.tables.get('BusFault')
  if (!faults?.records.length)
    return Array.from(buses.records, (_, row) => kase.native(buses, row) as number)
  return Array.from(faults.records, (_, row) => {
    const bus = kase.cell(faults, 'ports.bus', row)
    return typeof bus === 'number' ? (kase.native(buses, bus) as number) : NaN
  })
}

/** Runs `request` on `kase`, and reads what it writes into `run.results`. */
export async function simulate(
  kase: Case,
  request: SimulationRequest,
  run: Run,
  cache: ResultCache,
  context: RunContext,
): Promise<ResultsFile> {
  const { program, solver, output, root, gridkit, format } = request
  const folder = dirname(solver)
  // GridKit names a study's files from its output's stem alone, so they land where it runs.
  const ext = extname(output)
  const files = { base: join(folder, basename(output, ext)), ext }
  const stem = basename(files.base) + '_'
  /** The contingencies whose files are in the folder now. */
  const written = async () =>
    (await readdir(folder))
      .flatMap((name) => {
        const n =
          name.startsWith(stem) && name.endsWith(ext)
            ? name.slice(stem.length, name.length - ext.length)
            : ''
        return /^\d+$/.test(n) ? [Number(n)] : []
      })
      .sort((a, b) => a - b)
  // Studio reads what GridKit writes, so what this program is about to write over goes first:
  // GridKit would write over it anyway, and nothing the last run left can pass for this run's.
  const stale =
    program === 'DynamicSimulation'
      ? [output]
      : (await written()).map((n) => contingencyFile(files, n))
  await Promise.all(stale.map((file) => rm(file, { force: true })))
  const process = await launch(
    gridkit,
    program,
    { root, solver, touches: [fileURLToPath(request.uri), output] },
    context.signal,
    context.log,
    context.lifecycle,
  )
  /** The file at `path`, read as the run's results. */
  const reading = (path: string, more: Parameters<typeof described>[3]) => {
    const file = new ResultsFile(described(kase, request, path, { format, ...more }), kase, cache)
    run.results = file.info
    context.reading(file)
    return file
  }
  try {
    if (program === 'DynamicSimulation') {
      const file = reading(output, { growing: true, span: [0, request.tmax] })
      await file.ingest(context.signal, process.ended, context.progress)
      await process.done
      if (!file.info.frames)
        throw new Error(`DynamicSimulation wrote no samples to ${basename(output)}.`)
      return file
    }
    await process.done
    const contingencies = await written()
    if (!contingencies.length) throw new Error('No contingency wrote results.')
    const study: Study = {
      ...files,
      buses: contingencyBuses(kase),
      written: contingencies,
      failed: [...process.failed()],
      shown: contingencies[0]!,
    }
    const file = reading(contingencyFile(study, study.shown), { contingency: study })
    await file.ingest(context.signal, () => true, context.progress)
    return file
  } catch (error) {
    context.signal.throwIfAborted()
    // A native error is more useful than the missing file it caused.
    if (process.ended()) await process.done
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`${program} wrote no ${basename(output)}.`)
    throw error
  } finally {
    await process.stop()
    await process.done.catch(() => {})
  }
}
