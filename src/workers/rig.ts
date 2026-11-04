/** The worker as the extension runs it, for the worker's and the client's tests: bundled for Node,
 *  and asked through the extension's own side of the protocol. */
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { build } from 'esbuild'

import type { FromWorker, WorkerApi, WorkerEvent, WorkerOptions } from '../shared/messages.js'
import { Caller } from '../shared/rpc.js'

const require = createRequire(import.meta.url)
/** What the tests start the worker with, but for where it keeps the results it reads: room for the
 *  files they let go of to rest, and no saved session's results to keep. */
export const OPTIONS: Omit<WorkerOptions, 'store'> = {
  cacheBytes: 64 << 20,
  saved: [],
  wasmPath: require.resolve('latkit/wasm'),
}

/** Bundles the worker into `output/tests/<folder>`, as the extension ships it; its path. */
export async function bundle(folder: string): Promise<string> {
  const outfile = resolve('output/tests', folder, 'worker.mjs')
  await build({
    entryPoints: ['src/workers/worker.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);",
    },
    target: 'node22',
    mainFields: ['module', 'main'],
    logLevel: 'warning',
  })
  return outfile
}

/** The worker at `script`, started with `options`, with a folder of files of its own, where it
 *  keeps the results it reads, every event it sends kept. */
export async function start(
  script: string,
  { folder, options }: { folder?: string; options?: Partial<WorkerOptions> } = {},
) {
  const scratch = folder ?? (await mkdtemp(join(tmpdir(), 'gridkit-worker-test-')))
  const worker = new Worker(script, {
    workerData: { ...OPTIONS, store: join(scratch, 'store'), ...options } satisfies WorkerOptions,
  })
  const caller = new Caller<WorkerApi>((message) => worker.postMessage(message))
  const events: WorkerEvent[] = []
  worker.on('message', (message: FromWorker) => {
    if (message.kind === 'reply') caller.settle(message)
    else events.push(message)
  })
  return {
    scratch,
    events,
    call: <K extends keyof WorkerApi & string>(
      method: K,
      input: WorkerApi[K]['input'],
      signal?: AbortSignal,
    ) => caller.call(method, input, signal),
    async stop() {
      await worker.terminate()
      if (!folder) await rm(scratch, { recursive: true, force: true })
    },
  }
}

/** A worker as `start` starts one. */
export type Rig = Awaited<ReturnType<typeof start>>
