/** One run of GridKit on a solver file, in its folder, as a shell runs it. A DynamicSimulation is
 *  read while it writes its output. A ContingencyAnalysis shows the first contingency it wrote once
 *  it ends. */

import { readdir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ResultCache, Results } from '../results/index.js'
import type {
  RuntimeProcess,
  SimulationInfo,
  SimulationRequest,
  Study,
} from '../shared/simulation.js'
import { contingencyFile } from '../shared/study.js'
import type { Case } from './case.js'
import { launch } from './runtime.js'

export interface RunContext {
  readonly signal: AbortSignal
  /** Hears each Results the run reads, as soon as it reads it, so views can query it as it fills. */
  readonly reading: (results: Results) => void
  /** Hears each page of samples read. */
  readonly publish: () => Promise<void>
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

export async function simulate(
  kase: Case,
  request: SimulationRequest,
  info: SimulationInfo,
  cache: ResultCache,
  context: RunContext,
): Promise<Results> {
  const { program, solver, output, root, gridkit } = request
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
  try {
    if (program === 'DynamicSimulation') {
      const results = new Results(info, kase, cache)
      context.reading(results)
      await results.ingest(context.signal, process.ended, context.publish)
      await process.done
      if (!info.frames)
        throw new Error(`DynamicSimulation wrote no samples to ${basename(output)}.`)
      return results
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
    info.contingency = study
    info.path = contingencyFile(study, study.shown)
    const results = new Results(info, kase, cache)
    context.reading(results)
    await results.ingest(context.signal, () => true, context.publish)
    return results
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
