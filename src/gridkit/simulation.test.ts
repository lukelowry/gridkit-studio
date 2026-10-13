import { describe, expect, it } from 'vitest'

import { turn } from './simulation.js'

/** Lets every promise settled so far run on. */
const settled = () => new Promise((resolve) => setTimeout(resolve))

/** Whether this file system names a file alike in any case. */
const caseless = process.platform === 'win32' || process.platform === 'darwin'

describe('runs that write one file', () => {
  it('take turns, each waiting for every run before it, however soon one ends', async () => {
    const order: string[] = []
    const first = await turn('out.csv', new AbortController().signal)
    const stopped = new AbortController()
    const second = turn('out.csv', stopped.signal)
    const third = turn('out.csv', new AbortController().signal).then((end) => {
      order.push('third began')
      return end
    })
    // The second gives up its turn while the first still writes: the third still waits.
    stopped.abort(new Error('Stopped'))
    await expect(second).rejects.toThrow('Stopped')
    await settled()
    expect(order).toEqual([])
    order.push('first ended')
    first()
    ;(await third)()
    expect(order).toEqual(['first ended', 'third began'])
  })

  it.runIf(caseless)('take turns on a file however its path is cased', async () => {
    const first = await turn('cased.csv', new AbortController().signal)
    let began = false
    const second = turn('CASED.csv', new AbortController().signal).then((end) => {
      began = true
      return end
    })
    await settled()
    expect(began).toBe(false)
    first()
    ;(await second)()
  })

  it('wait for nothing when no run writes their file', async () => {
    const ends = await Promise.all([
      turn('a.csv', new AbortController().signal),
      turn('b.csv', new AbortController().signal),
    ])
    for (const end of ends) end()
    await settled()
    // Ended, a file's turn is anyone's.
    ;(await turn('a.csv', new AbortController().signal))()
  })
})
