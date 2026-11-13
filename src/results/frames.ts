/** The two forms a store keeps a field's frames in: as the file gave them, and as latkit draws
 *  them. */

/** Frames as the file gave them, each the values of the rows read of it, frame by frame. */
export interface FrameBlock {
  readonly first: number
  readonly at: Float64Array
  readonly values: Float64Array
}

/** A run of a field's entries at one level of detail, as latkit's `Patch.frames` takes it: at level
 *  0 each a frame, above it each a bucket of frames, its first and last times, then every bucket's
 *  least values, then every one's greatest. */
export interface VisualizationRun {
  readonly level: number
  readonly first: number
  readonly at: Float64Array
  readonly values: Float32Array
}

/** Conversion happens only at the visualization boundary, never in scientific storage. A value
 *  float32 cannot hold is a gap, as one that is not finite is. */
export function visualValues(values: Float64Array): Float32Array {
  const result = new Float32Array(values)
  for (let index = 0; index < result.length; index++)
    if (!Number.isFinite(result[index])) result[index] = NaN
  return result
}

export const rawRun = (block: FrameBlock): VisualizationRun => ({
  level: 0,
  first: block.first,
  at: block.at,
  values: visualValues(block.values),
})
