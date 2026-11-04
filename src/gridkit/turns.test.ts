import { expect, it } from 'vitest'

import { awaitedWork, Turns } from './turns.js'

/** Spends `ms` on the thread, as a long slice of work does. */
function spend(ms: number) {
  const ends = performance.now() + ms
  while (performance.now() < ends);
}

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

it('holds background work between its turns while a request someone waits on is under way', async () => {
  let finish!: () => void
  const request = awaitedWork(() => new Promise<void>((resolve) => (finish = resolve)))
  const background = new Turns(undefined, true)
  const foreground = new Turns()
  spend(20)
  let stepped = false
  const step = background.step().then(() => (stepped = true))
  // Work someone waits on goes on meanwhile.
  spend(20)
  await foreground.step()
  await later(30)
  expect(stepped).toBe(false)
  finish()
  await request
  await step
  expect(stepped).toBe(true)
})

it('lets go of background work waiting between its turns once its signal does', async () => {
  let finish!: () => void
  const request = awaitedWork(() => new Promise<void>((resolve) => (finish = resolve)))
  const controller = new AbortController()
  const background = new Turns(controller.signal, true)
  spend(20)
  const step = background.step()
  controller.abort(new Error('let go'))
  await expect(step).rejects.toThrow('let go')
  finish()
  await request
})
