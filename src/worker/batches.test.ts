import { expect, it } from 'vitest'

import { sendAhead } from './batches.js'

/** Lets every pending callback run. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

it('prepares the next packet while one awaits its acknowledgement, and no more', async () => {
  let prepared = 0
  async function* source() {
    for (let packet = 1; packet <= 3; packet++) {
      prepared = packet
      yield packet
    }
  }
  const sent: number[] = []
  const acknowledgements: (() => void)[] = []
  const done = sendAhead(source(), (packet) => {
    sent.push(packet)
    return new Promise<void>((resolve) => acknowledgements.push(resolve))
  })
  await settle()
  expect(sent).toEqual([1])
  expect(prepared).toBe(2)
  acknowledgements.shift()!()
  await settle()
  expect(sent).toEqual([1, 2])
  expect(prepared).toBe(3)
  acknowledgements.shift()!()
  await settle()
  expect(sent).toEqual([1, 2, 3])
  // The last packet is sent, but not done until it too is acknowledged.
  let finished = false
  void done.then(() => (finished = true))
  await settle()
  expect(finished).toBe(false)
  acknowledgements.shift()!()
  await done
})

it('fails as a packet fails, once it is next awaited', async () => {
  async function* source() {
    yield 1
    yield 2
  }
  const sent: number[] = []
  await expect(
    sendAhead(source(), async (packet) => {
      sent.push(packet)
      throw new Error('View stopped consuming data.')
    }),
  ).rejects.toThrow('View stopped consuming data.')
  expect(sent).toEqual([1])
})
