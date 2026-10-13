/** Each worker as the extension runs it, for the workers' and the client's tests: bundled for Node,
 *  and asked through the extension's own side of the protocol. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { build } from 'esbuild'

import type { FromWorker, ResultsOptions, WorkerEvent } from '../shared/messages.js'
import { type Api, Caller } from '../shared/rpc.js'

/** What the tests start the results worker with, but for where it keeps the results it reads:
 *  room for every chunk they read, and no saved session's results to keep. */
export const OPTIONS: Omit<ResultsOptions, 'store'> = { cacheBytes: 64 << 20, saved: [] }

/** Bundles the worker `name` into `output/tests/<folder>`, as the extension ships it; its path. */
export async function bundle(name: 'cases' | 'results', folder: string): Promise<string> {
  const outfile = resolve('output/tests', folder, name + '.cjs')
  await build({
    entryPoints: [`src/workers/${name}.ts`],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    mainFields: ['module', 'main'],
    logLevel: 'warning',
  })
  return outfile
}

/** The worker at `script`, started with `options`, with a folder of files of its own, where it
 *  keeps the results it reads, every event it sends kept. */
export async function start<A extends Api<A>>(
  script: string,
  { folder, options }: { folder?: string; options?: Partial<ResultsOptions> } = {},
) {
  const scratch = folder ?? (await mkdtemp(join(tmpdir(), 'gridkit-worker-test-')))
  const worker = new Worker(script, {
    workerData: { ...OPTIONS, store: join(scratch, 'store'), ...options } satisfies ResultsOptions,
  })
  const caller = new Caller<A>((message) => worker.postMessage(message))
  const events: WorkerEvent[] = []
  worker.on('message', (message: FromWorker) => {
    if (message.kind === 'reply') caller.settle(message)
    else events.push(message)
  })
  return {
    scratch,
    events,
    call: <K extends keyof A & string>(method: K, input: A[K]['input'], signal?: AbortSignal) =>
      caller.call(method, input, signal),
    async stop() {
      await worker.terminate()
      if (!folder) await rm(scratch, { recursive: true, force: true })
    },
  }
}
