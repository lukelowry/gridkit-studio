import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { expect, it } from 'vitest'

import { Analyses } from './analyses.js'

it('returns a job immediately, waits without polling and cancels only its own work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gridkit-analyses-'))
  const jobs = new Analyses(directory)
  const signal = new AbortController().signal
  const completed = await jobs.start(async () => {
    await delay(5)
    return { evidence: 'saved' }
  })
  expect(completed.status).toBe('running')
  expect(await jobs.read({ analysisId: completed.analysisId, waitMs: 1000 }, signal)).toMatchObject(
    {
      status: 'complete',
    },
  )
  const cancelled = await jobs.start(async (_, signal) => {
    await delay(10000, undefined, { signal })
    return {}
  })
  await jobs.stop(cancelled.analysisId, signal)
  expect(await jobs.read({ analysisId: cancelled.analysisId, waitMs: 1000 }, signal)).toMatchObject(
    { status: 'cancelled' },
  )
  expect(await jobs.read({ analysisId: completed.analysisId }, signal)).toMatchObject({
    status: 'complete',
  })
  await jobs.dispose()
  const restored = new Analyses(directory)
  expect(await restored.read({ analysisId: completed.analysisId }, signal)).toMatchObject({
    status: 'complete',
    analysisId: completed.analysisId,
  })
  await restored.dispose()
  await rm(directory, { recursive: true, force: true })
})
