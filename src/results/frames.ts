/** The two forms of a field's frames: raw, as the file has them, and reduced for latkit to draw. */

/** Raw frames: the values of the selected rows, frame by frame. */
export interface FrameBlock {
  readonly first: number
  readonly at: Float64Array
  readonly values: Float64Array
}

/** A run of a field's entries at one level of detail, as latkit's `Patch.frames` takes it. At level
 *  0 each entry is a frame. Above it each is a bucket: its first and last times, then every
 *  bucket's minimums, then every bucket's maximums. */
export interface VisualizationRun {
  readonly level: number
  readonly first: number
  readonly at: Float64Array
  readonly values: Float32Array
}

/** Converts to float32 for drawing only, never for storage. Values that are not finite, including
 *  those too large for float32, become NaN gaps. */
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
