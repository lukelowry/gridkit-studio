import type { FrameBlock, VisualizationRun } from '../shared/data.js'

/** Conversion happens only at the visualization boundary, never in scientific storage. A value
 *  float32 cannot hold is a gap, as one that is not finite is. */
export function visualValues(values: Float64Array): Float32Array {
  const result = new Float32Array(values)
  for (let index = 0; index < result.length; index++)
    if (!Number.isFinite(result[index])) result[index] = NaN
  return result
}

export function rawRun(block: FrameBlock): VisualizationRun {
  if (block.values.length !== block.at.length * block.rows)
    throw new Error('Result frame dimensions do not match.')
  return { level: 0, first: block.first, at: block.at, values: visualValues(block.values) }
}
