import type { SampleBatch } from '@latkit/model'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Begin, ToView } from '../shared/messages.js'

const transport = vi.hoisted(() => ({
  listener: (_message: ToView) => {},
  send: vi.fn(),
}))
vi.mock('./bridge.js', () => ({
  bridge: {
    on: (listener: (message: ToView) => void) => {
      transport.listener = listener
      return () => {}
    },
    send: transport.send,
    report: vi.fn(),
  },
}))
import { receive } from './stream.js'

const revision = { uri: 'file:///one', version: 1, attachmentId: 'first' }
const schema = {
  types: {
    Bus: {
      fields: {
        x: { type: 'float64' as const },
        v: { type: 'float64' as const, sampled: true as const },
      },
    },
  },
}
const begin = (stream: number): Begin => ({
  kind: 'begin',
  stream,
  base: true,
  schema,
  revision,
  counts: { Bus: 1 },
  fields: [{ from: 'Bus', select: ['x'] }],
})
const pages = (stream: number, simulationId = 'run'): Begin => ({
  kind: 'begin',
  stream,
  base: false,
  simulationId,
  pages: [0, 1],
  paging: 'cut',
  revision,
  counts: { Bus: 1 },
  fields: [{ from: 'Bus', select: ['v'] }],
})
const end = (stream: number): ToView => ({ kind: 'end', stream, coverage: [] })
const index = { source: 'case', type: 'Bus', version: 'one' }
const rows = (value: number) => ({
  kind: 'rows' as const,
  index,
  rows: { kind: 'range' as const, offset: 0, count: 1 },
  columns: {
    x: { kind: 'numeric' as const, values: new Float64Array([value]), offset: 0, length: 1 },
  },
})
const samples = (first: number): SampleBatch => ({
  kind: 'samples',
  index,
  rows: { kind: 'range', offset: 0, count: 1 },
  firstFrame: first,
  coordinates: Float64Array.of(first, first + 1),
  columns: {
    v: {
      kind: 'numeric',
      values: Float64Array.of(1, 2),
      offset: 0,
      length: 2,
      rowStride: 1,
      frameStride: 1,
    },
  },
})
const send = (message: ToView) => transport.listener(message)
const handlers = () => ({ rows: vi.fn(), pages: vi.fn(), settled: vi.fn() })

describe('atomic streams', () => {
  beforeEach(() => transport.send.mockClear())

  it('rejects missing batches without replacing the last accepted rows', () => {
    const held = handlers()
    receive(held)
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    send(end(1))
    send(begin(2))
    send({ kind: 'batch', stream: 2, sequence: 2, batches: [rows(2)] })
    send(end(2))
    expect(transport.send).toHaveBeenLastCalledWith({
      kind: 'commit',
      stream: 2,
      error: expect.objectContaining({ code: 'protocol' }),
    })
    expect(held.rows).toHaveBeenCalledOnce()
    // Pages still extend the rows held.
    send(pages(3))
    send({ kind: 'batch', stream: 3, sequence: 1, batches: [samples(0)] })
    send(end(3))
    expect(held.pages).toHaveBeenCalledOnce()
    expect(held.settled.mock.calls.map(([stream]) => stream)).toEqual([1, 2, 3])
  })

  it('rejects pages without the rows they extend, and takes them once the rows arrive', () => {
    const held = handlers()
    receive(held)
    send(pages(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [samples(0)] })
    send(end(1))
    expect(transport.send).toHaveBeenLastCalledWith({
      kind: 'commit',
      stream: 1,
      error: expect.objectContaining({ code: 'conflict' }),
    })
    expect(held.pages).not.toHaveBeenCalled()
    send(begin(2))
    send({ kind: 'batch', stream: 2, sequence: 1, batches: [rows(2)] })
    send(end(2))
    send(pages(3))
    send({ kind: 'batch', stream: 3, sequence: 1, batches: [samples(0)] })
    send(end(3))
    expect(held.pages).toHaveBeenCalledOnce()
    expect(held.pages.mock.calls[0]![0].samples).toHaveLength(1)
    expect(transport.send).toHaveBeenLastCalledWith({ kind: 'commit', stream: 3 })
  })

  it('rejects pages of another revision of the case', () => {
    const held = handlers()
    receive(held)
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    send(end(1))
    send({ ...pages(2), revision: { ...revision, version: 2 } })
    send(end(2))
    expect(transport.send).toHaveBeenLastCalledWith({
      kind: 'commit',
      stream: 2,
      error: expect.objectContaining({ code: 'conflict' }),
    })
    expect(held.pages).not.toHaveBeenCalled()
  })

  it('commits once, ignores superseded transactions, and acknowledges stale batches', () => {
    const held = handlers()
    receive(held)
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    expect(held.rows).not.toHaveBeenCalled()
    send(begin(2))
    send({ kind: 'batch', stream: 1, sequence: 2, batches: [rows(99)] })
    send(end(1))
    send({ kind: 'batch', stream: 2, sequence: 1, batches: [rows(2)] })
    send(end(2))
    send(end(2))
    send(begin(1))
    expect(held.rows).toHaveBeenCalledTimes(1)
    expect(held.rows.mock.calls[0]![0].begin.stream).toBe(2)
    expect(transport.send).toHaveBeenCalledWith({ kind: 'ack', stream: 1, sequence: 2 })
    expect(transport.send).toHaveBeenCalledWith({ kind: 'commit', stream: 2 })
  })

  it('rejects a stream the view no longer wants, and keeps what it held', () => {
    const held = handlers()
    receive({ ...held, accept: (message) => message.stream !== 2 })
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    send(end(1))
    send(pages(2))
    send({ kind: 'batch', stream: 2, sequence: 1, batches: [samples(0)] })
    send(end(2))
    expect(transport.send).toHaveBeenLastCalledWith({
      kind: 'commit',
      stream: 2,
      error: expect.objectContaining({ code: 'superseded' }),
    })
    expect(held.pages).not.toHaveBeenCalled()
  })

  it('rejects pages whose advertised samples are missing', () => {
    const held = handlers()
    receive(held)
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    send(end(1))
    send(pages(2))
    send({
      kind: 'end',
      stream: 2,
      coverage: [
        {
          from: 'Bus',
          field: 'v',
          rows: { kind: 'range', offset: 0, count: 1 },
          first: 0,
          count: 2,
          domain: [0, 1],
        },
      ],
    })
    expect(transport.send).toHaveBeenLastCalledWith({
      kind: 'commit',
      stream: 2,
      error: expect.objectContaining({ code: 'invalid-input' }),
    })
    expect(held.pages).not.toHaveBeenCalled()
  })

  it('does not reject an accepted transaction when its renderer fails afterward', () => {
    const held = {
      rows: vi.fn(() => {
        throw new Error('Renderer failed')
      }),
    }
    receive(held)
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    send(end(1))
    send(end(1))
    expect(held.rows).toHaveBeenCalledOnce()
    expect(transport.send).toHaveBeenLastCalledWith({ kind: 'commit', stream: 1 })
  })
})
