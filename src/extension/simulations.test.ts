import { expect, it, vi } from 'vitest'

import type { Receipt, Requests } from './requests.js'
import type { Sessions } from './sessions.js'
import type { Tasks } from './tasks.js'

vi.mock('vscode', () => ({ Uri: { parse: (uri: string) => uri } }))
vi.mock('./ai/context.js', () => ({
  resolveCase: async () => ({ document: {}, summary: { uri: 'file:///case', version: 1 } }),
  revision: (summary: unknown) => summary,
  paged: (value: unknown) => value,
}))
vi.mock('./sessions.js', () => ({ defaultOutputs: () => [] }))
vi.mock('./tasks.js', () => ({ gridkitOf: () => ({}), cacheBytesOf: () => 16 << 20 }))
import { Simulations } from './simulations.js'

it.each(['receipt', 'schedule'])(
  'stops the prepared simulation after %s failure',
  async (failure) => {
    const call = vi.fn(async (method: string) => {
      if (method === 'captureCase') return { snapshotId: 'snapshot', fingerprint: 'revision' }
      if (method === 'prepareSimulation') return { id: 'simulation' }
      if (method === 'stopSimulation') throw new Error('Cleanup also failed')
      return null
    })
    const studio = {
      open: async () => ({ values: {}, outputs: [] }),
      client: { call },
      report: vi.fn(),
    } as unknown as Sessions
    const start = vi.fn(async () => {
      if (failure === 'schedule') throw new Error('Scheduling failed')
    })
    const requests = {
      perform: async (
        _kind: string,
        _input: unknown,
        execute: (receipt: Receipt, save: () => Promise<void>) => Promise<unknown>,
      ) => {
        const receipt = { resourceId: 'simulation' } as Receipt
        return execute(receipt, async () => {
          if (failure === 'receipt' && receipt.state === 'accepted')
            throw new Error('Receipt save failed')
        })
      },
    } as Requests
    const simulations = new Simulations(studio, { start } as unknown as Tasks, requests)
    await expect(
      simulations.submit(
        { requestId: 'request', caseUri: 'file:///case', program: 'DynamicSimulation' },
        new AbortController().signal,
      ),
    ).rejects.toThrow(failure === 'receipt' ? 'Receipt save failed' : 'Scheduling failed')
    expect(call).toHaveBeenCalledWith('stopSimulation', { simulationId: 'simulation' })
    expect(call).toHaveBeenCalledWith('releaseSnapshot', { snapshotId: 'snapshot' })
    expect(start).toHaveBeenCalledTimes(failure === 'receipt' ? 0 : 1)
    expect(studio.report).toHaveBeenCalledOnce()
  },
)
