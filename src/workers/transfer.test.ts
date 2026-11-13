import { expect, it } from 'vitest'

import { transferables } from './transfer.js'

it('transfers each owned backing buffer once, even with cycles', () => {
  const bytes = new Uint8Array(8)
  const reply: { bytes: Uint8Array; copy: Uint8Array; self?: unknown } = {
    bytes,
    copy: bytes.subarray(2),
  }
  reply.self = reply
  expect(transferables(reply)).toEqual([bytes.buffer])
})
