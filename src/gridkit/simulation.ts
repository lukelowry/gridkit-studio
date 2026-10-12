/** One run of GridKit's DynamicSimulation on a solver file, in its folder, as a shell runs it, read
 *  while it writes its output. */

import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fileKey, type ResultCache, ResultsFile, type Stores } from '../results/index.js'
import type { RunRequest } from '../shared/simulation.js'
import type { Case } from './case.js'
import { type Launch, launch, placed, PROGRAM } from './runtime.js'

export interface RunContext extends Launch {
  /** Hears of the results file the run reads as soon as it reads it, so views can ask it for
   *  frames as it fills. */
  readonly reading: (file: ResultsFile) => void
  /** Hears of each run of frames read. */
  readonly progress: () => Promise<void> | void
}

/** The runs writing each output file, by its path as the file system compares paths. */
const writers = new Map<string, Promise<void>>()

/** Waits for every run before this one that writes `path` to end, unless `signal` lets go first:
 *  a run removes the file it writes as it starts, which another may still write. Returns what ends
 *  this run's turn, which the next waits for. */
export async function turn(path: string, signal: AbortSignal): Promise<() => void> {
  const key = fileKey(path)
  const before = writers.get(key)
  let end!: () => void
  const mine = new Promise<void>((resolve) => (end = resolve))
  // The next waits for this run and every run before it, however soon this one ends.
  const queue = before ? before.then(() => mine) : mine
  writers.set(key, queue)
  void queue.then(() => {
    if (writers.get(key) === queue) writers.delete(key)
  })
  if (before)
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        if (signal.aborted) return abort()
        signal.addEventListener('abort', abort, { once: true })
        void before.then(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        })
      })
    } catch (error) {
      end()
      throw error
    }
  return end
}

/** What the results of a run are read into: a worker's cache, and its stores. */
export interface Keeping {
  readonly cache: ResultCache
  readonly stores: Stores
}

/** Runs `request` on `kase`, and reads what it writes into results kept as `keeping` says, which
 *  `context` hears of before GridKit starts. Letting go of those results stops the run. */
export async function simulate(
  kase: Case,
  request: RunRequest,
  { cache, stores }: Keeping,
  context: RunContext,
): Promise<ResultsFile> {
  const { solver, output, root, gridkit, tmax } = request
  const place = { root, solver, touches: [fileURLToPath(request.uri), output] }
  // Where GridKit runs is settled before anything is touched: a run that cannot start leaves the
  // last run's file as it was.
  const runtime = await placed(gridkit, place, context.signal)
  const end = await turn(output, context.signal)
  try {
    // Studio reads what GridKit writes, so the file it is about to write over goes first: GridKit
    // would write over it anyway, and nothing the last run left can pass for this run's.
    await rm(output, { force: true })
    // GridKit opens its output without making the folder it names.
    await mkdir(dirname(output), { recursive: true })
    const file = new ResultsFile(kase, cache, await stores.create(output), {
      revision: request,
      path: output,
      solver,
      span: [0, tmax],
    })
    context.reading(file)
    const process = launch(runtime, place, context)
    try {
      await file.use(context.signal, (signal) =>
        file.ingest(signal, process.writer, context.progress),
      )
      await process.done
      if (!file.progress.frames)
        throw new Error(`${PROGRAM} wrote no samples to ${basename(output)}.`)
      return file
    } catch (error) {
      context.signal.throwIfAborted()
      // A native error is more useful than the missing file it caused.
      if (process.writer() !== 'writing') await process.done
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(`${PROGRAM} wrote no ${basename(output)}.`)
      throw error
    } finally {
      await process.stop()
      await process.done.catch(() => {})
    }
  } finally {
    end()
  }
}
