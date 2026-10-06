import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import { Requests } from './requests.js'

it('deduplicates concurrent retries, survives reload and rejects a changed payload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gridkit-requests-'))
  try {
    const requests = new Requests(directory)
    const execute = vi.fn(async (receipt) => ({
      requestId: receipt.requestId,
      simulationId: receipt.resourceId,
      status: 'accepted',
    }))
    const input = { requestId: 'one', parameters: { b: 2, a: 1 } }
    const [first, second] = await Promise.all([
      requests.perform('simulation', input, execute),
      requests.perform('simulation', { ...input, parameters: { a: 1, b: 2 } }, execute),
    ])
    expect(second).toEqual(first)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await new Requests(directory).perform('simulation', input, execute)).toEqual(first)
    await expect(
      requests.perform('simulation', { requestId: 'one', parameters: { a: 9 } }, execute),
    ).rejects.toMatchObject({ code: 'request-conflict' })
    expect(execute).toHaveBeenCalledTimes(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('never replays an edit whose effect may have occurred before its response was lost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gridkit-requests-'))
  try {
    const requests = new Requests(directory)
    const input = { requestId: 'uncertain' }
    const execute = vi.fn(async (receipt, save) => {
      receipt.state = 'prepared'
      receipt.beforeRevision = 'before'
      await save()
      throw new Error('Connection lost after applying')
    })
    await expect(requests.perform('case-edit', input, execute)).rejects.toThrow('Connection lost')
    expect(await new Requests(directory).perform('case-edit', input, execute)).toMatchObject({
      requestId: 'uncertain',
      status: 'unknown',
      beforeRevision: 'before',
    })
    expect(execute).toHaveBeenCalledTimes(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
