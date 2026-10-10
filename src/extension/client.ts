import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { CancellationToken } from 'vscode'

import { terminateRuntime } from '../gridkit/index.js'
import type {
  CaseApi,
  FromWorker,
  ResultsApi,
  RuntimeProcess,
  WorkerEvent,
} from '../shared/messages.js'
import { type Api, Caller } from '../shared/rpc.js'

/** Run `run` with a signal that aborts when `token` is cancelled. */
export async function cancellable<T>(
  token: CancellationToken | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const subscription = token?.onCancellationRequested(() => controller.abort())
  if (token?.isCancellationRequested) controller.abort()
  try {
    return await run(controller.signal)
  } finally {
    subscription?.dispose()
  }
}

/** Tells its listeners of each `T`, as VS Code's events do: subscribing returns what unsubscribes.
 *  One listener's failure leaves the others theirs. */
class Emitter<T> {
  readonly #listeners = new Set<(value: T) => void>()
  readonly event = (listener: (value: T) => void) => {
    this.#listeners.add(listener)
    return { dispose: () => void this.#listeners.delete(listener) }
  }
  fire(value: T): void {
    for (const listener of [...this.#listeners])
      try {
        listener(value)
      } catch (error) {
        queueMicrotask(() => {
          throw error
        })
      }
  }
  dispose(): void {
    this.#listeners.clear()
  }
}

/** What a worker's owner hears of it: its events. `release` ends what it started, before another
 *  worker takes its place. */
interface Owner {
  hear(event: WorkerEvent): void
  release(): Promise<void>
}

/** A worker of the extension's, started when first asked and again after it stops. */
class Thread<A extends Api<A>> {
  /** Hears why the worker stopped, each time it does. */
  readonly failure = new Emitter<Error>()
  #worker?: Worker
  #caller?: Caller<A>
  /** The teardown of one that stopped: calls wait for it before another starts. */
  #teardown?: Promise<void>
  #closed = false

  constructor(
    private readonly name: string,
    private readonly script: string,
    private readonly owner: Owner,
  ) {}

  /** Whether the worker runs now. */
  get running(): boolean {
    return this.#worker !== undefined
  }

  /** Calls `method` of the worker, starting it if it is not running. */
  async call<K extends keyof A & string>(
    method: K,
    input: A[K]['input'],
    signal?: AbortSignal,
  ): Promise<A[K]['output']> {
    signal?.throwIfAborted()
    if (this.#teardown) await this.#teardown
    if (this.#closed) throw new Error('Studio is closed.')
    return this.#start().call(method, input, signal)
  }

  #start(): Caller<A> {
    if (this.#caller) return this.#caller
    const worker = new Worker(this.script)
    const caller = new Caller<A>((message) => worker.postMessage(message))
    this.#worker = worker
    this.#caller = caller
    const stopped = (error: Error) => {
      if (this.#worker !== worker) return
      this.#worker = this.#caller = undefined
      // Set before anyone hears, so a call the failure prompts waits for the teardown.
      this.#teardown = this.owner
        .release()
        .then(() => worker.terminate())
        .then(
          () => {},
          () => {},
        )
        .finally(() => (this.#teardown = undefined))
      caller.fail(error)
      this.failure.fire(error)
    }
    worker.on('error', (error) =>
      stopped(
        Object.assign(new Error(`The ${this.name} worker stopped: ${error.message}`), {
          detail: error.stack,
        }),
      ),
    )
    worker.on('exit', (code) =>
      stopped(new Error(`The ${this.name} worker stopped (exit code ${code}).`)),
    )
    worker.on('message', (message: FromWorker) => {
      if (message.kind === 'reply') caller.settle(message)
      else this.owner.hear(message)
    })
    return caller
  }

  /** Stops the worker, failing what was asked of it. */
  async dispose(): Promise<void> {
    this.#closed = true
    const worker = this.#worker
    this.#worker = undefined
    this.#caller?.fail(new Error('Studio disposed.'))
    this.#caller = undefined
    await this.#teardown
    await worker?.terminate()
    this.failure.dispose()
  }
}

/** The extension's two workers: the case worker, which reads open cases as they are edited, and the
 *  results worker, which runs GridKit and reads results files. Their bundles are in `folder`. */
export class Client {
  readonly event = new Emitter<Exclude<WorkerEvent, { kind: 'process' }>>()
  /** The GridKit process the results worker runs for each case, terminated here if it dies. */
  readonly #owned = new Map<string, RuntimeProcess>()
  readonly cases: Thread<CaseApi>
  readonly results: Thread<ResultsApi>

  constructor(folder: string) {
    const owner = (release: () => Promise<void>): Owner => ({
      hear: (event) => {
        if (event.kind !== 'process') return this.event.fire(event)
        if (event.process) this.#owned.set(event.uri, event.process)
        else this.#owned.delete(event.uri)
      },
      release,
    })
    this.cases = new Thread(
      'case',
      join(folder, 'cases.cjs'),
      owner(async () => {}),
    )
    this.results = new Thread(
      'results',
      join(folder, 'results.cjs'),
      owner(() => this.#terminate()),
    )
  }

  /** What the workers running hold. */
  async stats() {
    const [cases, results] = await Promise.all([
      this.cases.running ? this.cases.call('stats', {}) : undefined,
      this.results.running ? this.results.call('stats', {}) : undefined,
    ])
    return { ...(cases && { cases }), ...(results && { results }) }
  }

  /** Ends every GridKit process the results worker started. */
  async #terminate() {
    const owned = [...this.#owned.values()]
    this.#owned.clear()
    await Promise.all(owned.map(terminateRuntime))
  }

  async dispose() {
    // A run under way ends as interrupted; nothing is started to be told to.
    if (this.results.running) await this.results.call('shutdown', {}).catch(() => {})
    await Promise.all([this.cases.dispose(), this.results.dispose()])
    await this.#terminate()
    this.event.dispose()
  }
}
