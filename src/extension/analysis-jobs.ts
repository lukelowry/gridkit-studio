import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { message } from '../shared/format.js'

interface Job {
  controller: AbortController
  done: Promise<void>
  state: 'running' | 'cancelling' | 'complete' | 'cancelled' | 'failed'
  result?: Record<string, unknown>
  error?: string
}

/** Background analyses are opt-in, explicitly cancellable, and end with this extension session. */
export class AnalysisJobs {
  readonly #jobs = new Map<string, Job>()
  start(run: (signal: AbortSignal) => Promise<Record<string, unknown>>) {
    const id = randomUUID()
    const controller = new AbortController()
    const job: Job = { controller, done: Promise.resolve(), state: 'running' }
    this.#jobs.set(id, job)
    job.done = Promise.resolve()
      .then(() => run(controller.signal))
      .then(
        (result) => {
          if (controller.signal.aborted) job.state = 'cancelled'
          else {
            job.result = result
            job.state = 'complete'
          }
        },
        (error) => {
          job.state = controller.signal.aborted ? 'cancelled' : 'failed'
          job.error = message(error)
        },
      )
    return { job: id, status: 'running', next: 'gridkit_analysis_job' }
  }
  async read(
    input: { job: string; action?: 'status' | 'cancel'; waitMs?: number },
    signal: AbortSignal,
  ) {
    const job = this.#jobs.get(input.job)
    if (!job) throw new Error('Unknown analysis job. Jobs end when this extension session closes.')
    const waitMs = input.waitMs ?? 0
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30000)
      throw new Error('Wait between 0 and 30000 milliseconds per status request.')
    if (input.action === 'cancel' && job.state === 'running') {
      job.state = 'cancelling'
      job.controller.abort(new Error('Analysis cancelled.'))
    }
    if (waitMs && (job.state === 'running' || job.state === 'cancelling')) {
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
    return {
      job: input.job,
      status: job.state,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
    }
  }
  dispose() {
    for (const job of this.#jobs.values()) job.controller.abort(new Error('GridKit closed.'))
    this.#jobs.clear()
  }
}
