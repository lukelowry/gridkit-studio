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

const begin = (stream: number, base = true): Begin => ({
  kind: 'begin',
  stream,
  ...(base
    ? { base, schema: { types: { Bus: { fields: { x: { type: 'float64' } } } } } }
    : { base }),
  append: !base,
  revision: { uri: 'file:///one', version: 1, attachmentId: 'first' },
  counts: { Bus: 1 },
  fields: [{ from: 'Bus', select: ['x'] }],
  sampled: [],
})
const end = (stream: number): ToView => ({ kind: 'end', stream, coverage: [] })
const rows = (value: number) => ({
  kind: 'rows' as const,
  index: { source: 'case', type: 'Bus', version: 'one' },
  rows: { kind: 'range' as const, offset: 0, count: 1 },
  columns: {
    x: { kind: 'numeric' as const, values: new Float64Array([value]), offset: 0, length: 1 },
  },
})
const send = (message: ToView) => transport.listener(message)

describe('atomic stream replacement', () => {
  beforeEach(() => transport.send.mockClear())

  it('rejects missing batches without replacing the last accepted base', () => {
    const held = vi.fn()
    receive(held)
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    send(end(1))
    const base = held.mock.calls[0]![0].rows
    send(begin(2))
    send({ kind: 'batch', stream: 2, sequence: 2, batches: [rows(2)] })
    send(end(2))
    expect(transport.send).toHaveBeenLastCalledWith({
      kind: 'commit',
      stream: 2,
      error: expect.objectContaining({ code: 'protocol' }),
    })
    send(begin(3, false))
    send(end(3))
    expect(held).toHaveBeenCalledTimes(2)
    expect(held.mock.calls[1]![0].rows).toBe(base)
  })

  it('rejects assembly failures and retries a complete replacement', () => {
    const held = vi.fn()
    receive(held)
    send(begin(1, false))
    send(end(1))
    expect(transport.send).toHaveBeenLastCalledWith({
      kind: 'commit',
      stream: 1,
      error: expect.objectContaining({ code: 'conflict' }),
    })
    expect(held).not.toHaveBeenCalled()
    send(begin(2))
    send({ kind: 'batch', stream: 2, sequence: 1, batches: [rows(2)] })
    send(end(2))
    expect(held).toHaveBeenCalledOnce()
    expect(transport.send).toHaveBeenLastCalledWith({ kind: 'commit', stream: 2 })
  })

  it('rejects appends from a different attachment or run', () => {
    const held = vi.fn()
    receive(held)
    send({ ...begin(1), simulationId: 'one' })
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    send(end(1))
    send({ ...begin(2, false), simulationId: 'two' })
    send(end(2))
    expect(transport.send).toHaveBeenLastCalledWith({
      kind: 'commit',
      stream: 2,
      error: expect.objectContaining({ code: 'conflict' }),
    })
    expect(held).toHaveBeenCalledOnce()
  })

  it('commits once, ignores superseded transactions, and acknowledges stale batches', () => {
    const held = vi.fn()
    receive(held)
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    expect(held).not.toHaveBeenCalled()
    send(begin(2))
    send({ kind: 'batch', stream: 1, sequence: 2, batches: [rows(99)] })
    send(end(1))
    send({ kind: 'batch', stream: 2, sequence: 1, batches: [rows(2)] })
    send(end(2))
    send(end(2))
    send(begin(1))
    expect(held).toHaveBeenCalledTimes(1)
    expect(held.mock.calls[0]![0].begin.stream).toBe(2)
    expect(transport.send).toHaveBeenCalledWith({ kind: 'ack', stream: 1, sequence: 2 })
    expect(transport.send).toHaveBeenCalledWith({ kind: 'commit', stream: 2 })
  })

  it('retains the last complete base when a replacement is no longer wanted', () => {
    const held = vi.fn()
    receive(held, (message) => message.stream !== 2)
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    send(end(1))
    const base = held.mock.calls[0]![0].rows
    send(begin(2))
    send({ kind: 'batch', stream: 2, sequence: 1, batches: [rows(2)] })
    send(end(2))
    send(begin(3, false))
    send(end(3))
    expect(held).toHaveBeenCalledTimes(2)
    expect(held.mock.calls[1]![0].rows).toBe(base)
  })

  it('rejects a structurally valid stream whose advertised samples are missing', () => {
    const held = vi.fn()
    receive(held)
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    send(end(1))
    const before = held.mock.calls[0]![0]
    send(begin(2, false))
    send({
      kind: 'end',
      stream: 2,
      coverage: [
        {
          from: 'Bus',
          field: 'missing',
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
    expect(held).toHaveBeenCalledOnce()
    send(begin(3, false))
    send(end(3))
    expect(held.mock.calls[1]![0].rows).toBe(before.rows)
  })

  it('does not reject an accepted transaction when its renderer fails afterward', () => {
    const held = vi.fn(() => {
      throw new Error('Renderer failed')
    })
    receive(held)
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    send(end(1))
    send(end(1))
    expect(held).toHaveBeenCalledOnce()
    expect(transport.send).toHaveBeenLastCalledWith({ kind: 'commit', stream: 1 })
    send(begin(2, false))
    send(end(2))
    expect(transport.send).toHaveBeenLastCalledWith({ kind: 'commit', stream: 2 })
  })
})
