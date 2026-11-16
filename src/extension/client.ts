import { terminateRuntime } from '../gridkit/index.js'
import { browser } from '../platform/host.js'
import { join } from '../platform/path.js'
import { Worker } from '../platform/thread.js'
import type {
  FromWorker,
  RuntimeProcess,
  WorkerApi,
  WorkerEvent,
  WorkerOptions,
} from '../shared/messages.js'
import { type Api, Caller } from '../shared/rpc.js'

/** An event emitter shaped like VS Code's. A throwing listener does not stop the others; its
 *  error goes to `failed`. */
class Emitter<T> {
  readonly #listeners = new Set<(value: T) => void>()
  constructor(private readonly failed: (error: unknown) => void) {}
  readonly event = (listener: (value: T) => void) => {
    this.#listeners.add(listener)
    return { dispose: () => void this.#listeners.delete(listener) }
  }
  fire(value: T): void {
    for (const listener of [...this.#listeners])
      try {
        listener(value)
      } catch (error) {
        this.failed(error)
      }
  }
  dispose(): void {
    this.#listeners.clear()
  }
}

/** Receives a worker's events. `release` cleans up after a worker stops, before the next starts. */
interface Owner {
  handleEvent(event: WorkerEvent): void
  release(): Promise<void>
}

/** A worker thread, started on first call and restarted after it stops. */
class Thread<A extends Api<A>> {
  /** Fires with the reason each time the worker stops. */
  readonly failure: Emitter<Error>
  #worker?: Worker
  #caller?: Caller<A>
  /** The teardown of a stopped worker; calls wait for it before a new one starts. */
  #teardown?: Promise<void>
  #closed = false

  constructor(
    private readonly script: string,
    private readonly owner: Owner,
    failed: (error: unknown) => void,
    /** The `workerData` for each started worker. */
    private readonly data?: () => unknown,
  ) {
    this.failure = new Emitter(failed)
  }

  get running(): boolean {
    return this.#worker !== undefined
  }

  async call<K extends keyof A & string>(
    method: K,
    input: A[K]['input'],
    signal?: AbortSignal,
  ): Promise<A[K]['output']> {
    signal?.throwIfAborted()
    if (this.#teardown) await this.#teardown
    if (this.#closed) throw new Error('GridKit Studio is closed.')
    return this.#start().call(method, input, signal)
  }

  #start(): Caller<A> {
    if (this.#caller) return this.#caller
    const worker = new Worker(this.script, { workerData: this.data?.() })
    const caller = new Caller<A>((message) => worker.postMessage(message))
    this.#worker = worker
    this.#caller = caller
    const stopped = (error: Error) => {
      if (this.#worker !== worker) return
      this.#worker = this.#caller = undefined
      // Set before firing, so a call made by a failure listener waits for the teardown.
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
        Object.assign(new Error(`GridKit Studio's worker stopped: ${error.message}`), {
          detail: error.stack,
        }),
      ),
    )
    worker.on('exit', (code) =>
      stopped(new Error(`GridKit Studio's worker stopped (exit code ${code}).`)),
    )
    worker.on('message', (message: FromWorker) => {
      if (message.kind === 'reply') caller.settle(message)
      else this.owner.handleEvent(message)
    })
    return caller
  }

  async dispose(): Promise<void> {
    this.#closed = true
    const worker = this.#worker
    this.#worker = undefined
    this.#caller?.fail(new Error('GridKit Studio is closed.'))
    this.#caller = undefined
    await this.#teardown
    await worker?.terminate()
    this.failure.dispose()
  }
}

/** The extension's worker, which reads case files, runs GridKit and reads results files. It loads
 *  its bundle from `folder` and starts with `options`; listener errors go to `failed`. */
export class Client {
  readonly event: Emitter<Exclude<WorkerEvent, { kind: 'process' }>>
  /** GridKit processes by run id, ended here if the worker stops first. */
  readonly #processes = new Map<string, RuntimeProcess>()
  readonly worker: Thread<WorkerApi>

  constructor(
    folder: string,
    options: () => Omit<WorkerOptions, 'wasmPath'>,
    failed: (error: unknown) => void,
  ) {
    const wasmPath = join(folder, 'webview', 'latkit.wasm')
    this.event = new Emitter(failed)
    this.worker = new Thread(
      join(folder, ...(browser ? ['browser'] : []), 'worker.mjs'),
      {
        handleEvent: (event) => {
          if (event.kind !== 'process') return this.event.fire(event)
          if (event.process) this.#processes.set(event.run, event.process)
          else this.#processes.delete(event.run)
        },
        release: () => this.#terminate(),
      },
      failed,
      () => ({
        ...options(),
        wasmPath,
        solver: {
          worker: join(folder, ...(browser ? ['browser'] : []), 'solver.mjs'),
          module: join(folder, 'solver', 'DynamicSimulation.mjs'),
          wasm: join(folder, 'solver', 'DynamicSimulation.wasm'),
        },
      }),
    )
  }

  /** Counts of the worker's open cases, results, files and runs, while it runs. */
  async stats() {
    return this.worker.running ? this.worker.call('stats', {}) : undefined
  }

  async #terminate() {
    const processes = [...this.#processes.values()]
    this.#processes.clear()
    await Promise.all(processes.map(terminateRuntime))
  }

  async dispose() {
    await this.worker.dispose()
    await this.#terminate()
    this.event.dispose()
  }
}
