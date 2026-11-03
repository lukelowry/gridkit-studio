import { expect, it, vi } from 'vitest'

import type { FrameRequest } from '../../shared/data.js'
import { type FeedSource, PlotFeed } from './feed.js'

const window = (range: [number, number]): FrameRequest => ({
  results: 'run',
  table: 'Bus',
  field: 'Vm',
  range,
  purpose: 'plot',
  columns: 100,
})

/** A feed over a page whose reads and draws end only when the test says, as a slow GPU's do. */
function rig() {
  let recorded = 10
  const reads: { version: number; signal: AbortSignal; end(changed?: boolean): void }[] = []
  const draws: { signal: AbortSignal; end(): void }[] = []
  let viewed = false
  const source: FeedSource = {
    read: (_request, version, signal) =>
      new Promise((resolve) =>
        reads.push({ version, signal, end: (changed = true) => resolve(changed) }),
      ),
    drawn: (signal) =>
      viewed ? new Promise((resolve) => draws.push({ signal, end: () => resolve() })) : undefined,
    version: () => recorded,
    received: vi.fn(),
    failed: vi.fn(),
  }
  return {
    feed: new PlotFeed(source),
    source,
    reads,
    draws,
    record: (frames: number) => (recorded = frames),
    view: () => (viewed = true),
  }
}
const settled = () => new Promise((resolve) => setTimeout(resolve))

it('reads one window at a time, and reads again what was recorded meanwhile', async () => {
  const { feed, source, reads, record } = rig()
  feed.want(window([0, 10]))
  await settled()
  expect(reads.map((read) => read.version)).toEqual([10])
  // Frames recorded while a read is under way wait for it, and arrive in one read after it.
  for (const frames of [20, 30, 40]) {
    record(frames)
    feed.want(window([0, 10]))
  }
  await settled()
  expect(reads).toHaveLength(1)
  reads[0]!.end()
  await settled()
  expect(reads.map((read) => read.version)).toEqual([10, 40])
  expect(reads[0]!.signal.aborted).toBe(false)
  reads[1]!.end()
  await settled()
  expect(source.received).toHaveBeenCalledTimes(2)
})

it('reads once the view has drawn what it holds', async () => {
  const { feed, reads, draws, view } = rig()
  view()
  feed.want(window([0, 10]))
  await settled()
  expect(reads).toHaveLength(0)
  draws[0]!.end()
  await settled()
  expect(reads).toHaveLength(1)
})

it('lets go of the read under way for another window, and says nothing of it', async () => {
  const { feed, source, reads } = rig()
  feed.want(window([0, 10]))
  await settled()
  feed.want(window([2, 4]))
  await settled()
  expect(reads[0]!.signal.aborted).toBe(true)
  expect(reads).toHaveLength(2)
  feed.stop()
  expect(reads[1]!.signal.aborted).toBe(true)
  expect(source.failed).not.toHaveBeenCalled()
})

it('says why a read failed, and tries again when asked', async () => {
  const { feed, source } = rig()
  const reading = vi.spyOn(source, 'read').mockRejectedValueOnce(new Error('lost'))
  feed.want(window([0, 10]))
  await settled()
  expect(source.failed).toHaveBeenCalledWith(new Error('lost'))
  feed.want(window([0, 10]))
  await settled()
  expect(reading).toHaveBeenCalledTimes(2)
})
