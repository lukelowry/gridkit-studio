import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { problem, toolProblem } from '../shared/ai.js'

interface Status {
  analysisId: string
  status: 'running' | 'cancelling' | 'complete' | 'cancelled' | 'failed' | 'interrupted'
  error?: Record<string, unknown>
}
interface Job {
  controller: AbortController
  done: Promise<void>
  value: Status
}

/** One identity from acceptance through immutable paged findings, including after reload. */
export class Analyses {
  readonly #jobs = new Map<string, Job>()
  constructor(
    readonly directory: string,
    readonly published: (id: string, signal: AbortSignal) => Promise<boolean> = async () => false,
  ) {}
  #path(id: string) {
    if (!/^[\da-f-]{36}$/i.test(id))
      throw problem('analysis-not-found', 'Invalid analysis identifier.')
    return join(this.directory, id + '.json')
  }
  async #save(value: Status) {
    await mkdir(this.directory, { recursive: true })
    const path = this.#path(value.analysisId)
    const temporary = path + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, JSON.stringify(value))
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true }).catch(() => {})
    }
  }
  async start(calculate: (analysisId: string, signal: AbortSignal) => Promise<unknown>) {
    const analysisId = randomUUID()
    const value: Status = { analysisId, status: 'running' }
    await this.#save(value)
    const controller = new AbortController()
    const job: Job = { controller, done: Promise.resolve(), value }
    this.#jobs.set(analysisId, job)
    job.done = Promise.resolve()
      .then(() => calculate(analysisId, controller.signal))
      .then(
        () => {
          // Publication wins over a cancellation that arrives after calculation completes.
          value.status = 'complete'
        },
        (error) => {
          value.status = controller.signal.aborted
            ? controller.signal.reason?.code === 'interrupted'
              ? 'interrupted'
              : 'cancelled'
            : 'failed'
          value.error = toolProblem(error, controller.signal.aborted)
        },
      )
      .then(() => this.#save(value))
      .finally(() => this.#jobs.delete(analysisId))
    void job.done.catch(() => {})
    return { ...value }
  }
  async read(input: { analysisId: string; waitMs?: number }, signal: AbortSignal): Promise<Status> {
    const job = this.#jobs.get(input.analysisId)
    const waitMs = input.waitMs ?? 0
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30000)
      throw problem('invalid-input', 'waitMs must be between 0 and 30000.')
    if (job && waitMs) {
      const timer = new AbortController()
      try {
        await Promise.race([
          job.done,
          delay(waitMs, undefined, { signal: AbortSignal.any([signal, timer.signal]) }),
        ])
      } finally {
        timer.abort()
      }
    }
    signal.throwIfAborted()
    if (job) {
      // A cancelled IPC wait can lose the reply after the worker has committed its findings.
      if (
        !['running', 'cancelling', 'complete'].includes(job.value.status) &&
        (await this.published(input.analysisId, signal))
      )
        return { analysisId: input.analysisId, status: 'complete' }
      return { ...job.value }
    }
    let value: Status
    try {
      value = JSON.parse(await readFile(this.#path(input.analysisId), 'utf8')) as Status
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw problem('analysis-not-found', 'Unknown analysis.', { analysisId: input.analysisId })
      throw error
    }
    if (value.status !== 'complete' && (await this.published(input.analysisId, signal)))
      return { analysisId: input.analysisId, status: 'complete' }
    if (value.status === 'running' || value.status === 'cancelling') {
      throw problem(
        'analysis-owner-unavailable',
        'This extension instance cannot control this analysis. Its originating window may still be working.',
        { analysisId: input.analysisId },
      )
    }
    return value
  }
  async stop(analysisId: string, signal: AbortSignal) {
    const job = this.#jobs.get(analysisId)
    if (job && job.value.status === 'running') {
      job.value.status = 'cancelling'
      job.controller.abort(new Error('Analysis cancelled.'))
    }
    return this.read({ analysisId }, signal)
  }
  async dispose() {
    for (const job of this.#jobs.values())
      job.controller.abort(problem('interrupted', 'GridKit closed.'))
    await Promise.allSettled([...this.#jobs.values()].map((job) => job.done))
  }
}
