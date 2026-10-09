import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { type CancellationToken, EventEmitter, type ExtensionContext } from 'vscode'

import { terminateRuntime } from '../gridkit/index.js'
import type { FromWorker, Method, Requests, RuntimeProcess } from '../shared/messages.js'

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

/** The case worker, which reads open cases as they are edited, and the results worker, which runs
 *  GridKit and reads results files. */
type Side = 'cases' | 'results'
const SCRIPTS: Record<Side, string> = { cases: 'worker.cjs', results: 'results.cjs' }
/** What the results worker answers: runs and results files. A query, rows or presentation of a
 *  results file's case are its too. */
const RESULTS: ReadonlySet<Method> = new Set([
  'describeResults',
  'samples',
  'step',
  'run',
  'open',
  'clear',
  'export',
])
function sideOf(method: Method, input: unknown): Side {
  if (RESULTS.has(method)) return 'results'
  const results = (input as { results?: unknown } | null)?.results
  return (method === 'query' || method === 'rows' || method === 'presentation') &&
    typeof results === 'string'
    ? 'results'
    : 'cases'
}

type Stats = Requests['stats']['output']
/** What the workers hold, together. */
function total(each: readonly unknown[]): Stats {
  const sum = (of: (stats: Stats) => number) =>
    (each as readonly Stats[]).reduce((n, stats) => n + of(stats), 0)
  return {
    cacheBytes: sum((stats) => stats.cacheBytes),
    sessions: sum((stats) => stats.sessions),
    results: sum((stats) => stats.results),
    memory: {
      heapUsed: sum((stats) => stats.memory.heapUsed),
      arrayBuffers: sum((stats) => stats.memory.arrayBuffers),
    },
  }
}

export class Client {
  readonly #workers = new Map<Side, Worker>()
  #next = 0
  #disposed = false
  /** The GridKit process the results worker runs for each case, terminated here if it dies. */
  #owned = new Map<string, RuntimeProcess>()
  /** Pending teardown of a failed worker; its calls wait for it before starting another. */
  readonly #cleanup = new Map<Side, Promise<void>>()
  #pending = new Map<
    number,
    {
      side: Side
      resolve(value: unknown): void
      reject(error: Error): void
      cleanup(): void
    }
  >()
  readonly event = new EventEmitter<Extract<FromWorker, { kind: 'run' | 'results' | 'log' }>>()
  readonly failure = new EventEmitter<Error>()
  constructor(private readonly context: ExtensionContext) {}
  #get(side: Side) {
    const running = this.#workers.get(side)
    if (running) return running
    const worker = new Worker(join(this.context.extensionPath, 'dist', SCRIPTS[side]))
    this.#workers.set(side, worker)
    const failed = (error: Error) => {
      if (this.#workers.get(side) !== worker) return
      this.#workers.delete(side)
      // Set before anyone hears of the failure, so a call it prompts waits for the teardown.
      const owned = side === 'results' ? [...this.#owned.values()] : []
      if (side === 'results') this.#owned.clear()
      this.#cleanup.set(
        side,
        Promise.all(owned.map(terminateRuntime))
          .then(() => worker.terminate())
          .then(() => {})
          .finally(() => this.#cleanup.delete(side)),
      )
      for (const [id, entry] of this.#pending)
        if (entry.side === side) {
          entry.cleanup()
          entry.reject(error)
          this.#pending.delete(id)
        }
      this.failure.fire(error)
    }
    worker.on('error', (error) =>
      failed(
        Object.assign(new Error(`The ${side} worker stopped: ${error.message}`), {
          detail: error.stack,
        }),
      ),
    )
    worker.on('exit', (code) =>
      failed(new Error(`The ${side} worker stopped (exit code ${code}).`)),
    )
    worker.on('message', (message: FromWorker) => {
      if (message.kind === 'process') {
        if (message.process) this.#owned.set(message.uri, message.process)
        else this.#owned.delete(message.uri)
        return
      }
      if (message.kind === 'run' || message.kind === 'results' || message.kind === 'log')
        return this.event.fire(message)
      const pending = this.#pending.get(message.id)
      if (!pending) return
      pending.cleanup()
      this.#pending.delete(message.id)
      if (message.kind === 'error')
        pending.reject(
          Object.assign(new Error(message.problem.message), {
            ...message.problem,
            offset: message.offset,
            length: message.length,
            ...(message.defect && { defect: true, detail: message.detail }),
          }),
        )
      else pending.resolve(message.value)
    })
    return worker
  }
  call<K extends Method>(
    method: K,
    input: Requests[K]['input'],
    signal?: AbortSignal,
  ): Promise<Requests[K]['output']> {
    // Only the workers running are asked to stop, or what they hold: none is started to answer.
    if (method === 'shutdown' || method === 'stats') {
      const answers = Promise.all(
        [...this.#workers.keys()].map((side) => this.#call(side, method, {})),
      )
      return (method === 'shutdown' ? answers.then(() => null) : answers.then(total)) as Promise<
        Requests[K]['output']
      >
    }
    return this.#call(sideOf(method, input), method, input, signal)
  }
  #call<K extends Method>(
    side: Side,
    method: K,
    input: Requests[K]['input'],
    signal?: AbortSignal,
  ): Promise<Requests[K]['output']> {
    if (this.#disposed) return Promise.reject(new Error('Studio is closed.'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    const cleanup = this.#cleanup.get(side)
    if (cleanup) return cleanup.then(() => this.#call(side, method, input, signal))
    const worker = this.#get(side)
    const id = ++this.#next
    return new Promise((resolve, reject) => {
      const abort = () => {
        worker.postMessage({ kind: 'cancel', id })
        this.#pending.delete(id)
        cleanup()
        reject(signal?.reason ?? new Error('Cancelled'))
      }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      this.#pending.set(id, {
        side,
        resolve: (value) => resolve(value as Requests[K]['output']),
        reject,
        cleanup,
      })
      signal?.addEventListener('abort', abort, { once: true })
      worker.postMessage({ kind: 'request', id, method, input })
    })
  }
  async dispose() {
    await this.call('shutdown', {}).catch(() => {})
    this.#disposed = true
    const workers = [...this.#workers.values()]
    this.#workers.clear()
    for (const pending of this.#pending.values()) {
      pending.cleanup()
      pending.reject(new Error('Studio disposed.'))
    }
    this.#pending.clear()
    await Promise.all([...this.#owned.values()].map(terminateRuntime))
    this.#owned.clear()
    await Promise.all(this.#cleanup.values())
    await Promise.all(workers.map((worker) => worker.terminate()))
    this.event.dispose()
    this.failure.dispose()
  }
}
