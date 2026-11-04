import { spawn } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import type { RunRequest } from '../shared/messages.js'
import { bundle, OPTIONS } from '../workers/rig.js'
import { Client } from './client.js'

/** The worker as the extension ships it. */
let shipped: string
/** A worker that reports a GridKit process when asked to run, answers anything else with `ok`,
 *  and crashes when asked to open. */
let crashing: string
beforeAll(async () => {
  shipped = dirname(await bundle('client'))
  await mkdir(join(shipped, 'webview'), { recursive: true })
  await copyFile(OPTIONS.wasmPath, join(shipped, 'webview', 'latkit.wasm'))
  crashing = resolve('output/tests/client-crashing')
  await mkdir(crashing, { recursive: true })
  await writeFile(
    join(crashing, 'worker.mjs'),
    `import { parentPort } from 'node:worker_threads'
parentPort.on('message', (message) => {
  if (message.kind !== 'request') return
  if (message.method === 'open') throw new Error('The stand-in crashed.')
  if (message.method === 'run')
    return parentPort.postMessage({
      kind: 'process',
      run: message.input.run,
      process: { pid: message.input.pid, executable: 'node' },
    })
  parentPort.postMessage({ kind: 'reply', id: message.id, value: 'ok' })
})
`,
  )
})

const ONE = '{"buses":[{"class":"Bus","number":1,"name":"one"}]}'
/** The worker as the tests start it, keeping what it reads under the tests' output. */
const options = () => ({ ...OPTIONS, store: resolve('output/tests/client-store') })
/** What a listener's failure is said by. */
const failed = vi.fn()

describe('the worker the extension asks', () => {
  it('starts the worker once asked, and asks what it holds only while it runs', async () => {
    const client = new Client(shipped, options, failed)
    try {
      expect(await client.stats()).toBeUndefined()
      const file = resolve('output/tests/client-one.case.json')
      await writeFile(file, ONE)
      const summary = await client.worker.call('read', {
        uri: pathToFileURL(file).href,
        version: 1,
      })
      expect(summary.counts.Bus).toBe(1)
      expect(await client.stats()).toMatchObject({ cases: 1, results: 0, files: 0, runs: 0 })
      await expect(client.worker.call('describe', { results: 'none' })).rejects.toMatchObject({
        code: 'results-closed',
      })
    } finally {
      await client.dispose()
    }
    await expect(client.worker.call('stats', {})).rejects.toThrow(/closed/)
  })

  it('ends what a stopped worker started, fails what was asked of it, and starts again', async () => {
    const gridkit = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    })
    const client = new Client(crashing, options, failed)
    const stopped = vi.fn()
    client.worker.failure.event(stopped)
    try {
      const run = client.worker.call('run', {
        uri: 'file:///one',
        run: 'first',
        pid: gridkit.pid,
      } as unknown as RunRequest)
      // Answered after the worker reported the process, which the client now owns.
      expect(await client.worker.call('stats', {})).toBe('ok')
      const open = client.worker.call('open', {
        uri: 'file:///one',
        version: 1,
        results: 'any',
        path: 'any.csv',
      })
      await expect(open).rejects.toThrow(/worker stopped/)
      await expect(run).rejects.toThrow(/worker stopped/)
      expect(stopped).toHaveBeenCalledOnce()
      // The process it started is ended with it.
      await vi.waitFor(() => expect(() => process.kill(gridkit.pid!, 0)).toThrow(), {
        timeout: 5000,
      })
      // Asked again, another worker answers.
      expect(await client.worker.call('stats', {})).toBe('ok')
    } finally {
      gridkit.kill()
      await client.dispose()
    }
  })
})
