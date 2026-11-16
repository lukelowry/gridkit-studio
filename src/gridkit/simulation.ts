/** Runs GridKit on a solver file in its folder, as a shell would, and reads the output live. */

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
  /** Called as soon as reading starts, so views can request frames as the file fills. */
  readonly reading: (file: ResultsFile) => void
  readonly progress: () => Promise<void> | void
}

const writers = new Map<string, Promise<void>>()

/** Waits for earlier runs writing `path`, which would overwrite each other. Returns the function
 *  that ends this run's turn. */
export async function turn(path: string, signal: AbortSignal): Promise<() => void> {
  const key = fileKey(path)
  const before = writers.get(key)
  let end!: () => void
  const mine = new Promise<void>((resolve) => (end = resolve))
  // The next run waits for this one and every earlier one, even if this one ends first.
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

/** Runs `request` on `kase`. Retiring the results file it reads stops the run. */
export async function simulate(
  kase: Case,
  request: RunRequest,
  stores: Stores,
  context: RunContext,
): Promise<ResultsFile> {
  const { solver, output, gridkit, tmax } = request
  // Resolve the runtime before touching anything, so a run that cannot start leaves the previous
  // output intact.
  const runtime = await available(gridkit, context.signal)
  if (runtime.kind === 'wasm') {
    if (!context.wasm) throw new Error('The included GridKit solver is missing.')
    await solverBytes(context.wasm.wasm)
    context.signal.throwIfAborted()
  }
  const end = await turn(output, context.signal)
  let unlock: (() => void) | undefined
  try {
    unlock = await lockOutput(output, context.signal)
    // GridKit does not create its output folder.
    await mkdir(dirname(output), { recursive: true })
    // The previous output stays until GridKit overwrites it, and its stamp keeps it unread.
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
      // A stopped run's output is still read to the end. Only retiring the results stops reading.
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
      await file.settle()
    }
  } finally {
    unlock?.()
    end()
  }
}
