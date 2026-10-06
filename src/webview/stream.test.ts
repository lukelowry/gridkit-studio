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
  },
}))
import { receive } from './stream.js'

const begin = (stream: number, base = true): Begin => ({
  kind: 'begin',
  stream,
  base,
  append: !base,
  revision: { uri: 'file:///one', version: 1, attachmentId: 'first' },
  schema: { types: { Bus: { fields: { x: { type: 'float64' } } } } },
  fields: [{ from: 'Bus', select: ['x'] }],
  sampled: [],
})
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

  it('commits once, ignores superseded transactions, and acknowledges stale batches', () => {
    const held = vi.fn()
    const failed = vi.fn()
    receive(held, failed)
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    expect(held).not.toHaveBeenCalled()
    send(begin(2))
    send({ kind: 'batch', stream: 1, sequence: 2, batches: [rows(99)] })
    send({ kind: 'end', stream: 1 })
    send({ kind: 'batch', stream: 2, sequence: 1, batches: [rows(2)] })
    send({ kind: 'end', stream: 2 })
    send({ kind: 'end', stream: 2 })
    send(begin(1))
    expect(held).toHaveBeenCalledTimes(1)
    expect(held.mock.calls[0]![1].stream).toBe(2)
    expect(transport.send).toHaveBeenCalledWith({ kind: 'ack', stream: 1, sequence: 2 })
    expect(failed).not.toHaveBeenCalled()
  })

  it('retains the last complete base when a replacement is no longer wanted', () => {
    const held = vi.fn()
    receive(held, vi.fn(), (message) => message.stream !== 2)
    send(begin(1))
    send({ kind: 'batch', stream: 1, sequence: 1, batches: [rows(1)] })
    send({ kind: 'end', stream: 1 })
    const base = held.mock.calls[0]![2]
    send(begin(2))
    send({ kind: 'batch', stream: 2, sequence: 1, batches: [rows(2)] })
    send({ kind: 'end', stream: 2 })
    send(begin(3, false))
    send({ kind: 'end', stream: 3 })
    expect(held).toHaveBeenCalledTimes(2)
    expect(held.mock.calls[1]![2]).toBe(base)
  })
})
