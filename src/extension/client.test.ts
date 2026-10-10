import { spawn } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { RunRequest } from '../shared/messages.js'
import { bundle } from '../workers/rig.js'
import { Client } from './client.js'

/** The workers as the extension ships them, side by side. */
let shipped: string
/** The case worker beside a results worker that reports a GridKit process when asked to run,
 *  answers anything else with `ok`, and crashes when asked to open. */
let crashing: string
beforeAll(async () => {
  shipped = dirname(await bundle('cases', 'client'))
  await bundle('results', 'client')
  crashing = resolve('output/tests/client-crashing')
  await mkdir(crashing, { recursive: true })
  await copyFile(join(shipped, 'cases.cjs'), join(crashing, 'cases.cjs'))
  await writeFile(
    join(crashing, 'results.cjs'),
    `const { parentPort } = require('node:worker_threads')
parentPort.on('message', (message) => {
  if (message.kind !== 'request') return
  if (message.method === 'open') throw new Error('The stand-in crashed.')
  if (message.method === 'run')
    return parentPort.postMessage({
      kind: 'process',
      uri: message.input.uri,
      process: { pid: message.input.pid, executable: 'node' },
    })
  parentPort.postMessage({ kind: 'reply', id: message.id, value: 'ok' })
})
`,
  )
})

const ONE = '{"buses":[{"class":"Bus","number":1,"name":"one"}]}'

describe('the workers the extension asks', () => {
  it('asks each worker its own methods, and only those running what they hold', async () => {
    const client = new Client(shipped)
    try {
      expect(await client.stats()).toEqual({})
      const summary = await client.cases.call('parse', {
        uri: 'file:///one',
        version: 1,
        text: ONE,
      })
      expect(summary.counts.Bus).toBe(1)
      // Only the case worker has been asked anything, so only it is running.
      expect(await client.stats()).toEqual({ cases: expect.objectContaining({ cases: 1 }) })
      await expect(client.results.call('describe', { results: 'none' })).rejects.toMatchObject({
        code: 'results-unavailable',
      })
      expect(await client.stats()).toMatchObject({ cases: { cases: 1 }, results: { files: 0 } })
    } finally {
      await client.dispose()
    }
    await expect(client.cases.call('stats', {})).rejects.toThrow(/closed/)
  })

  it('ends what a stopped worker started, fails what was asked of it, and starts again', async () => {
    const gridkit = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    })
    const client = new Client(crashing)
    const stopped = vi.fn()
    const casesStopped = vi.fn()
    client.results.failure.event(stopped)
    client.cases.failure.event(casesStopped)
    try {
      const run = client.results.call('run', {
        uri: 'file:///one',
        pid: gridkit.pid,
      } as unknown as RunRequest)
      // Answered after the worker reported the process, which the client now owns.
      expect(await client.results.call('stats', {})).toBe('ok')
      const open = client.results.call('open', {
        uri: 'file:///one',
        version: 1,
        text: ONE,
        path: 'any.csv',
        cacheBytes: 16 << 20,
      })
      await expect(open).rejects.toThrow(/results worker stopped/)
      await expect(run).rejects.toThrow(/results worker stopped/)
      expect(stopped).toHaveBeenCalledOnce()
      // The process it started is ended with it.
      await vi.waitFor(() => expect(() => process.kill(gridkit.pid!, 0)).toThrow(), {
        timeout: 5000,
      })
      // Asked again, another worker answers.
      expect(await client.results.call('stats', {})).toBe('ok')
      // The case worker never stopped, and its owner heard nothing.
      expect(await client.cases.call('stats', {})).toMatchObject({ cases: 0 })
      expect(casesStopped).not.toHaveBeenCalled()
    } finally {
      gridkit.kill()
      await client.dispose()
    }
  })
})
