import { once } from 'node:events'
import { type AddressInfo, connect, createServer } from 'node:net'

import { Client } from '@modelcontextprotocol/client'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { describe, expect, it, vi } from 'vitest'

import { createAdapter } from './mcp-server.js'

vi.mock('vscode', () => ({}))

async function fixture(
  run: (input: unknown, signal: AbortSignal) => Promise<Record<string, unknown>>,
) {
  const handles: { close(): Promise<void> }[] = []
  const attach = createAdapter(
    [{ name: 'test', message: '', readOnly: true, run }],
    [
      {
        name: 'test',
        displayName: 'Test',
        modelDescription: 'Test',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'number', minimum: 0 }, text: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ],
    '1',
  )
  const server = createServer((socket) => {
    handles.push(attach(socket))
    socket.on('error', () => socket.destroy())
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const socket = connect((server.address() as AddressInfo).port, '127.0.0.1')
  await once(socket, 'connect')
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StdioServerTransport(socket, socket))
  return {
    client,
    socket,
    async close() {
      await client.close()
      socket.destroy()
      await Promise.all(handles.map((handle) => handle.close()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe('MCP adapter', () => {
  it('takes a message past the SDK default of 10 MiB', async () => {
    const run = vi.fn(async () => ({}))
    const test = await fixture(run)
    try {
      const text = 'x'.repeat(11 << 20)
      const result = await test.client.callTool({ name: 'test', arguments: { value: 1, text } })
      expect(result.isError).toBeFalsy()
      expect(run).toHaveBeenCalledWith({ value: 1, text }, expect.anything())
    } finally {
      await test.close()
    }
  })
  it('cancels work when its client disconnects', async () => {
    let aborted = false
    let entered = false
    const test = await fixture(async (_input, signal) => {
      entered = true
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(signal.reason)
          },
          { once: true },
        ),
      )
      return {}
    })
    const call = test.client.callTool({ name: 'test', arguments: { value: 1 } }).catch(() => {})
    await vi.waitFor(() => expect(entered).toBe(true))
    await test.close()
    await call
    await vi.waitFor(() => expect(aborted).toBe(true))
  })
  it('validates arguments and returns the whole result', async () => {
    const source = {
      rows: Array.from({ length: 100 }, (_, id) => ({ id, value: 'x'.repeat(1000) })),
      offset: 0,
      total: 100,
    }
    const run = vi.fn(async () => source)
    const test = await fixture(run)
    try {
      const rejected = await test.client.callTool({ name: 'test', arguments: { value: -1 } })
      expect(rejected.isError).toBe(true)
      expect(run).not.toHaveBeenCalled()
      const result = await test.client.callTool({ name: 'test', arguments: { value: 1 } })
      expect(result.structuredContent).toMatchObject({ total: 100, returned: 100 })
      expect(result.structuredContent).not.toHaveProperty('truncated')
      expect((result.structuredContent as typeof source).rows).toHaveLength(100)
    } finally {
      await test.close()
    }
  })
  it('runs every concurrent request, and passes on its cancellation', async () => {
    let active = 0
    let cancelled = 0
    const test = await fixture(async (_input, signal) => {
      active++
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled++
              reject(signal.reason)
            },
            { once: true },
          )
          signal.throwIfAborted()
        })
        return {}
      } finally {
        active--
      }
    })
    const controllers = Array.from({ length: 12 }, () => new AbortController())
    try {
      const calls = controllers.map((controller) =>
        test.client
          .callTool({ name: 'test', arguments: { value: 1 } }, { signal: controller.signal })
          .catch(() => undefined),
      )
      await vi.waitFor(() => expect(active).toBe(12))
      controllers.forEach((controller) => controller.abort())
      await Promise.all(calls)
      await vi.waitFor(() => expect(cancelled).toBe(12))
      expect(active).toBe(0)
    } finally {
      await test.close()
    }
  })
})
