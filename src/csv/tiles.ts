import type { Series } from '@latkit/model'

import { ByteBudget } from '../budget.js'
import { BLOCK_BYTES, integer } from './limits.js'
export type SampleWindow = Parameters<Series['read']>[1]
function* tileWindows(
  series: Series,
  signalIndex: number,
  window: SampleWindow,
  signal?: AbortSignal,
  budget = BLOCK_BYTES,
) {
  signal?.throwIfAborted()
  const head = series.state.frameCount
  const { frameOffset, frameCount, elementOffset, elementCount } = window
  if (
    ![signalIndex, frameOffset, frameCount, elementOffset, elementCount, budget].every(integer) ||
    budget < 16 ||
    signalIndex >= series.signalCount ||
    frameOffset > head ||
    frameCount > head - frameOffset ||
    elementOffset > series.elementCount ||
    elementCount > series.elementCount - elementOffset
  )
    throw new RangeError('Invalid sample tile window or budget.')
  if (!frameCount) return
  const width = Math.min(Math.max(1, elementCount), Math.floor(budget / 8) - 1)
  for (let e = 0; e < Math.max(1, elementCount); e += width) {
    const columns = Math.min(width, elementCount - e)
    const frames = Math.floor(budget / 8 / (columns + 1))
    for (let f = 0; f < frameCount; f += frames) {
      signal?.throwIfAborted()
      const tile = {
        frameOffset: frameOffset + f,
        frameCount: Math.min(frames, frameCount - f),
        elementOffset: elementOffset + e,
        elementCount: columns,
      }
      yield tile
    }
  }
}

const retainedSamples = new ByteBudget(64 * 1024 * 1024)
/** Each yielded tile owns its byte reservation until its consumer calls release(). */
export async function* leasedSampleTiles(
  series: Series,
  signalIndex: number,
  window: SampleWindow,
  signal?: AbortSignal,
  budget = BLOCK_BYTES,
) {
  for await (const tile of tileWindows(series, signalIndex, window, signal, budget)) {
    const release = await retainedSamples.acquire(
      tile.frameCount * (tile.elementCount + 1) * 8,
      signal,
    )
    try {
      const samples = await series.read(signalIndex, tile, signal)
      signal?.throwIfAborted()
      yield { window: tile, ...samples, release }
    } catch (error) {
      release()
      throw error
    }
  }
}

export async function* sampleTiles(
  series: Series,
  signalIndex: number,
  window: SampleWindow,
  signal?: AbortSignal,
  budget = BLOCK_BYTES,
) {
  for (const tile of tileWindows(series, signalIndex, window, signal, budget)) {
    const samples = await series.read(signalIndex, tile, signal)
    signal?.throwIfAborted()
    yield { window: tile, ...samples }
  }
}
