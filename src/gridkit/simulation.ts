/** One run of GridKit's DynamicSimulation on a solver file, in its folder, as a shell runs it, read
 *  while it writes its output. */

import { mkdir } from '../platform/files.js'
import { lockOutput } from '../platform/host.js'
import { basename, dirname } from '../platform/path.js'
import { fileKey, ResultsFile, stampAt, type Stores } from '../results/index.js'
import type { RunRequest } from '../shared/simulation.js'
import type { Case } from './case.js'
import { available, type Launch, launch } from './runtime.js'
import { launchWasm, solverBytes, type WasmAssets } from './wasm.js'

interface RunContext extends Launch {
  readonly wasm?: WasmAssets
  /** Hears of the results file the run reads as soon as it reads it, so views can ask it for
   *  frames as it fills. */
  readonly reading: (file: ResultsFile) => void
  /** Hears of each run of frames read. */
  readonly progress: () => Promise<void> | void
}

/** The runs writing each output file, by its path as the file system compares paths. */
const writers = new Map<string, Promise<void>>()

/** Waits for every run before this one that writes `path` to end, unless `signal` lets go first:
 *  two runs writing one file at once would each write over the other. Returns what ends this run's
 *  turn, which the next waits for. */
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

/** Runs `request` on `kase`, and reads what it writes into results kept in `stores`, which
 *  `context` hears of before GridKit starts. Letting go of those results stops the run. */
export async function simulate(
  kase: Case,
  request: RunRequest,
  stores: Stores,
  context: RunContext,
): Promise<ResultsFile> {
  const { solver, output, gridkit, tmax } = request
  // Where GridKit runs is settled before anything is touched: a run that cannot start leaves the
  // last run's file as it was.
  const runtime = await available(gridkit, context.signal)
  if (runtime.kind === 'wasm') {
    if (!context.wasm) throw new Error('Bundled GridKit WebAssembly assets are unavailable.')
    await solverBytes(context.wasm.wasm)
    context.signal.throwIfAborted()
  }
  const end = await turn(output, context.signal)
  let unlock: (() => void) | undefined
  try {
    unlock = await lockOutput(output, context.signal)
    // GridKit opens its output without making the folder it names.
    await mkdir(dirname(output), { recursive: true })
    // The file the last run left stays until GridKit writes over it, as a shell's run leaves it: a
    // run that never starts leaves it whole, and nothing of it is read as this run's.
    const last = await stampAt(output)
    const file = new ResultsFile(kase, await stores.create(output), {
      revision: request,
      path: output,
      solver,
      span: [0, tmax],
    })
    context.reading(file)
    const process =
      runtime.kind === 'wasm'
        ? await launchWasm(request, context.wasm!, context)
        : launch(runtime, solver, context)
    try {
      // A quick rerun can keep the same file stamp. Wait for WASM to open its new output.
      if ('started' in process) await process.started
      // Stopping the run stops GridKit: what it wrote is read to its end, as any stopped writer's
      // file is, and only letting go of the results stops the reading.
      await file.use(undefined, (signal) =>
        file.ingest(
          signal,
          process.writer,
          context.progress,
          'started' in process ? undefined : last,
        ),
      )
      await process.done
      if (!file.progress.frames)
        throw new Error(`${runtime.program} wrote no samples to ${basename(output)}.`)
      return file
    } catch (error) {
      context.signal.throwIfAborted()
      // A native error is more useful than the missing file it caused.
      if (process.writer() !== 'writing') await process.done
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(`${runtime.program} wrote no ${basename(output)}.`)
      throw error
    } finally {
      await process.stop()
      await process.done.catch(() => {})
      // GridKit has stopped writing: what was read of its file exports, however the reading ended.
      await file.settle()
    }
  } finally {
    unlock?.()
    end()
  }
}
