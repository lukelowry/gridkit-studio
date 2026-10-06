import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

it('does not overwrite another instance and recovers already published findings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gridkit-analyses-'))
  const owner = new Analyses(directory)
  const observer = new Analyses(directory, async () => false)
  const signal = new AbortController().signal
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  try {
    const job = await owner.start(() => pending)
    await expect(observer.read(job, signal)).rejects.toMatchObject({
      code: 'analysis-owner-unavailable',
      analysisId: job.analysisId,
    })
    const path = join(directory, job.analysisId + '.json')
    expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('running')
    finish()
    await owner.read({ ...job, waitMs: 1000 }, signal)
    // Simulate publication succeeding but the final status write being lost.
    await writeFile(path, JSON.stringify(job))
    const recovered = new Analyses(directory, async () => true)
    expect(await recovered.read(job, signal)).toMatchObject({ status: 'complete' })
    expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('running')
    for (const status of ['cancelled', 'failed', 'interrupted']) {
      await writeFile(path, JSON.stringify({ ...job, status, error: { code: 'reply-lost' } }))
      expect(await recovered.read(job, signal)).toEqual({
        analysisId: job.analysisId,
        status: 'complete',
      })
    }
  } finally {
    finish()
    await owner.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('distinguishes shutdown from cancellation and keeps a published result complete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gridkit-analyses-'))
  const jobs = new Analyses(directory)
  const signal = new AbortController().signal
  try {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const published = await jobs.start(() => pending)
    finish()
    await jobs.stop(published.analysisId, signal)
    expect(await jobs.read({ ...published, waitMs: 1000 }, signal)).toMatchObject({
      status: 'complete',
    })
    const interrupted = await jobs.start((_, signal) => delay(10000, undefined, { signal }))
    await jobs.dispose()
    expect(await jobs.read(interrupted, signal)).toMatchObject({ status: 'interrupted' })
  } finally {
    await jobs.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
