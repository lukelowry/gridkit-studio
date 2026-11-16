import { expect, it } from 'vitest'

import { awaitedWork, Turns } from './turns.js'

/** Busy-waits for `ms`, like a long slice of work. */
function spend(ms: number) {
  const ends = performance.now() + ms
  while (performance.now() < ends);
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

it('pauses background work between turns while foreground work is in progress', async () => {
  let finish!: () => void
  const request = awaitedWork(() => new Promise<void>((resolve) => (finish = resolve)))
  const background = new Turns(undefined, true)
  const foreground = new Turns()
  spend(20)
  let stepped = false
  const step = background.step().then(() => (stepped = true))
  // Foreground work continues meanwhile.
  spend(20)
  await foreground.step()
  await later(30)
  expect(stepped).toBe(false)
  finish()
  await request
  await step
  expect(stepped).toBe(true)
})

it('releases paused background work when its signal aborts', async () => {
  let finish!: () => void
  const request = awaitedWork(() => new Promise<void>((resolve) => (finish = resolve)))
  const controller = new AbortController()
  const background = new Turns(controller.signal, true)
  spend(20)
  const step = background.step()
  controller.abort(new Error('Stopped'))
  await expect(step).rejects.toThrow('Stopped')
  finish()
  await request
})
