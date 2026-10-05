import { setTimeout as delay } from 'node:timers/promises'

import { expect, it } from 'vitest'

import { AnalysisJobs } from './analysis-jobs.js'

it('returns a job immediately, waits without polling and cancels only its own work', async () => {
  const jobs = new AnalysisJobs()
  const signal = new AbortController().signal
  const completed = jobs.start(async () => {
    await delay(5)
    return { evidence: 'saved' }
  })
  expect(completed.status).toBe('running')
  expect(await jobs.read({ job: completed.job, waitMs: 1000 }, signal)).toMatchObject({
    status: 'complete',
    result: { evidence: 'saved' },
  })
  const cancelled = jobs.start(async (signal) => {
    await delay(10000, undefined, { signal })
    return {}
  })
  expect(
    await jobs.read({ job: cancelled.job, action: 'cancel', waitMs: 1000 }, signal),
  ).toMatchObject({ status: 'cancelled' })
  expect(await jobs.read({ job: completed.job }, signal)).toMatchObject({ status: 'complete' })
  jobs.dispose()
})
