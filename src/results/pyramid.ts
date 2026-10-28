import type { VisualizationRun } from '../shared/data.js'
import { visualValues } from './frames.js'

interface Bucket {
  readonly index: number
  readonly start: number
  end: number
  count: number
  readonly low: Float32Array
  readonly high: Float32Array
  readonly gaps: Uint8Array
}

/** The planner must refine a gapped bucket rather than join a line across a missing sample. */
export interface ReducedRun extends VisualizationRun {
  readonly gaps: Uint8Array
}

export interface PyramidState {
  readonly rows: number
  readonly next: number
  readonly last: number | null
  readonly levels: readonly (null | {
    readonly index: number
    readonly start: number
    readonly end: number
    readonly count: number
    readonly low: readonly (number | null)[]
    readonly high: readonly (number | null)[]
    readonly gaps: readonly number[]
  })[]
}

/** Eight-way streaming min/max reduction; at most seven children per level stay resident. */
export class Pyramid {
  readonly #levels: Array<Bucket | undefined> = []
  #next = 0
  #last = -Infinity

  constructor(
    private readonly rows: number,
    private readonly emit: (run: ReducedRun) => void,
  ) {
    if (!Number.isSafeInteger(rows) || rows < 1)
      throw new Error('A pyramid needs a positive row count.')
  }

  get next(): number {
    return this.#next
  }

  push(first: number, at: Float64Array, input: Float64Array): void {
    if (first !== this.#next || input.length !== at.length * this.rows) {
      throw new Error('Pyramid input must contain consecutive complete frames.')
    }
    // Validate the entire block before mutating reducer state.
    let previous = this.#last
    for (const time of at) {
      if (!Number.isFinite(time) || time < previous)
        throw new Error('Result times must be finite and nondecreasing.')
      previous = time
    }
    const values = visualValues(input)
    for (let frame = 0; frame < at.length; frame++) {
      const offset = frame * this.rows
      const rowValues = values.subarray(offset, offset + this.rows)
      const gaps = Uint8Array.from(rowValues, (value) => (Number.isNaN(value) ? 1 : 0))
      this.#add(1, first + frame, at[frame]!, at[frame]!, rowValues, rowValues, gaps)
    }
    this.#next += at.length
    this.#last = previous
  }

  snapshot(): PyramidState {
    return {
      rows: this.rows,
      next: this.#next,
      last: Number.isFinite(this.#last) ? this.#last : null,
      levels: Array.from(this.#levels, (bucket) =>
        bucket
          ? {
              ...bucket,
              low: Array.from(bucket.low, (value) => (Number.isFinite(value) ? value : null)),
              high: Array.from(bucket.high, (value) => (Number.isFinite(value) ? value : null)),
              gaps: Array.from(bucket.gaps),
            }
          : null,
      ),
    }
  }

  restore(state: PyramidState): void {
    if (this.#next !== 0 || this.#levels.length !== 0)
      throw new Error('Restore requires a new reducer.')
    if (
      state.rows !== this.rows ||
      !Number.isSafeInteger(state.next) ||
      state.next < 0 ||
      state.levels.length > 22
    ) {
      throw new Error('Invalid pyramid checkpoint.')
    }
    const levels = state.levels.map((bucket, level): Bucket | undefined => {
      if (!bucket) return undefined
      const stride = 8 ** (level - 1)
      if (
        level < 1 ||
        bucket.count !== Math.floor(state.next / stride) % 8 ||
        bucket.count < 1 ||
        bucket.index !== Math.floor(state.next / (stride * 8)) ||
        bucket.low.length !== this.rows ||
        bucket.high.length !== this.rows ||
        bucket.gaps.length !== this.rows ||
        !Number.isFinite(bucket.start) ||
        !Number.isFinite(bucket.end) ||
        bucket.end < bucket.start
      ) {
        throw new Error('Invalid pyramid tail.')
      }
      return {
        ...bucket,
        low: Float32Array.from(bucket.low, (value) => value ?? Infinity),
        high: Float32Array.from(bucket.high, (value) => value ?? -Infinity),
        gaps: Uint8Array.from(bucket.gaps),
      }
    })
    this.#levels.push(...levels)
    this.#next = state.next
    this.#last = state.last ?? -Infinity
  }

  #add(
    level: number,
    child: number,
    start: number,
    end: number,
    low: Float32Array,
    high: Float32Array,
    gaps: Uint8Array,
  ): void {
    if (level > 21) return
    const index = Math.floor(child / 8)
    let bucket = this.#levels[level]
    if (!bucket) {
      bucket = {
        index,
        start,
        end,
        count: 0,
        low: new Float32Array(this.rows).fill(Infinity),
        high: new Float32Array(this.rows).fill(-Infinity),
        gaps: new Uint8Array(this.rows),
      }
      this.#levels[level] = bucket
    }
    if (bucket.index !== index) throw new Error('Pyramid input skipped a bucket.')
    bucket.end = end
    bucket.count++
    for (let row = 0; row < this.rows; row++) {
      if (Number.isFinite(low[row])) bucket.low[row] = Math.min(bucket.low[row]!, low[row]!)
      if (Number.isFinite(high[row])) bucket.high[row] = Math.max(bucket.high[row]!, high[row]!)
      bucket.gaps[row]! |= gaps[row]!
    }
    if (bucket.count !== 8) return
    this.#levels[level] = undefined
    for (let row = 0; row < this.rows; row++) {
      if (bucket.low[row] === Infinity) bucket.low[row] = NaN
      if (bucket.high[row] === -Infinity) bucket.high[row] = NaN
    }
    const values = new Float32Array(this.rows * 2)
    values.set(bucket.low)
    values.set(bucket.high, this.rows)
    this.emit({
      level,
      first: bucket.index,
      at: Float64Array.of(bucket.start, bucket.end),
      values,
      gaps: bucket.gaps.slice(),
    })
    this.#add(
      level + 1,
      bucket.index,
      bucket.start,
      bucket.end,
      bucket.low,
      bucket.high,
      bucket.gaps,
    )
  }
}
