export const BLOCK_BYTES = 1024 * 1024
export const MAX_READ_BYTES = 64 * 1024 * 1024
export const MAX_RECORD_BYTES = 16 * 1024 * 1024
export const MAX_COLUMNS = 262144
export const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export function sampleBytes(frames: number, elements: number, limit = MAX_READ_BYTES): number {
  if (
    ![frames, elements, limit].every(integer) ||
    limit < 16 ||
    elements > Number.MAX_SAFE_INTEGER - 1
  )
    throw new RangeError('Invalid sample dimensions or budget.')
  if (frames > Math.floor(limit / 8 / (elements + 1)))
    throw new RangeError(
      'Sample window exceeds the read budget. Use tiled reads or a smaller window.',
    )
  return frames * (elements + 1) * 8
}
