/** One run of GridKit's DynamicSimulation on a solver file, in its folder, as a shell runs it, read
 *  while it writes its output. */

import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ResultCache, ResultsFile } from '../results/index.js'
import type { RunRequest, RuntimeProcess } from '../shared/simulation.js'
import type { Case } from './case.js'
import { launch, placed, PROGRAM } from './runtime.js'

export interface RunContext {
  readonly signal: AbortSignal
  /** Hears of the results file the run reads as soon as it reads it, so views can ask it for
   *  frames as it fills. */
  readonly reading: (file: ResultsFile) => void
  /** Hears of each run of frames read. */
  readonly progress: () => Promise<void> | void
  readonly log: (message: string) => void
  readonly lifecycle?: (process?: RuntimeProcess) => void
}

/** Runs `request` on `kase`, and reads what it writes into the results `request.results` names.
 *  Closing those results stops the run. */
export async function simulate(
  kase: Case,
  request: RunRequest,
  cache: ResultCache,
  context: RunContext,
): Promise<ResultsFile> {
  const { solver, output, root, gridkit, tmax } = request
  const place = { root, solver, touches: [fileURLToPath(request.uri), output] }
  // Where GridKit runs is settled before anything is touched: a run that cannot start leaves the
  // last run's file as it was.
  const runtime = await placed(gridkit, place, context.signal)
  // Studio reads what GridKit writes, so the file it is about to write over goes first: GridKit
  // would write over it anyway, and nothing the last run left can pass for this run's.
  await rm(output, { force: true })
  // GridKit opens its output without making the folder it names.
  await mkdir(dirname(output), { recursive: true })
  const process = launch(runtime, place, context.signal, context.log, context.lifecycle)
  const file = new ResultsFile(kase, cache, {
    id: request.results,
    revision: request,
    path: output,
    solver,
    span: [0, tmax],
  })
  context.reading(file)
  try {
    await file.use(context.signal, (signal) => file.ingest(signal, process.ended, context.progress))
    await process.done
    if (!file.info.frames) throw new Error(`${PROGRAM} wrote no samples to ${basename(output)}.`)
    return file
  } catch (error) {
    context.signal.throwIfAborted()
    // A native error is more useful than the missing file it caused.
    if (process.ended()) await process.done
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`${PROGRAM} wrote no ${basename(output)}.`)
    throw error
  } finally {
    await process.stop()
    await process.done.catch(() => {})
  }
}
