import { type Id, Patch } from 'latkit'

import type { FrameBlock, VisualizationRun } from '../shared/data.js'

/** Conversion happens only at the visualization boundary, never in scientific storage. */
export function visualValues(values: Float64Array): Float32Array {
  const result = new Float32Array(values.length)
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    if (!Number.isFinite(value)) {
      result[index] = NaN
      continue
    }
    const rounded = Math.fround(value)
    if (!Number.isFinite(rounded)) {
      throw Object.assign(
        new Error('A result value exceeds Latkit’s float32 visualization range.'),
        { code: 'limit' },
      )
    }
    result[index] = rounded
  }
  return result
}

export function rawRun(block: FrameBlock): VisualizationRun {
  if (block.values.length !== block.at.length * block.rows)
    throw new Error('Result frame dimensions do not match.')
  return { level: 0, first: block.first, at: block.at, values: visualValues(block.values) }
}

export function initializeFrames(source: string, table: string, ids: readonly Id[]): Uint8Array {
  return new Patch(source).axis('time', 's').replace(table, ids).toBytes()
}

export function framePatch(
  source: string,
  table: string,
  field: string,
  run: VisualizationRun,
): Uint8Array {
  return new Patch(source).frames(table, field, run).toBytes()
}
