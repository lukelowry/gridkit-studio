import { type VisualizationRun, visualValues } from './frames.js'

interface Bucket {
  readonly index: number
  readonly start: number
  end: number
  count: number
  readonly low: Float32Array
  readonly high: Float32Array
}

export interface PyramidState {
  readonly rows: number
  readonly next: number
  readonly levels: readonly (null | {
    readonly index: number
    readonly start: number
    readonly end: number
    readonly count: number
    readonly low: readonly (number | null)[]
    readonly high: readonly (number | null)[]
  })[]
}

/** Each row's minimum, then each row's maximum, as Patch.frames expects a bucket. NaN for a row
 *  without values. */
function bounds(rows: number, low: Float32Array, high: Float32Array): Float32Array {
  const values = new Float32Array(rows * 2)
  for (let row = 0; row < rows; row++) {
    values[row] = low[row] === Infinity ? NaN : low[row]!
    values[rows + row] = high[row] === -Infinity ? NaN : high[row]!
  }
  return values
}

/** Eight-way streaming min/max reduction matching latkit's levels of detail: level `k` has each
 *  row's minimum and maximum over buckets of `8^k` frames, ignoring missing values. At most seven
 *  children per level stay in memory. */
export class Pyramid {
  readonly #levels: Array<Bucket | undefined> = []
  #next = 0

  constructor(
    private readonly rows: number,
    private readonly emit: (run: VisualizationRun) => void,
  ) {
    if (!Number.isSafeInteger(rows) || rows < 1)
      throw new Error('A pyramid needs a positive row count.')
  }

  /** Reduces `at.length` frames from frame `first`. The caller has already checked their times. */
  push(first: number, at: Float64Array, input: Float64Array): void {
    if (first !== this.#next || input.length !== at.length * this.rows) {
      throw new Error('Pyramid input must contain consecutive complete frames.')
    }
    const values = visualValues(input)
    for (let frame = 0; frame < at.length; frame++) {
      const offset = frame * this.rows
      const rowValues = values.subarray(offset, offset + this.rows)
      this.#add(1, first + frame, at[frame]!, at[frame]!, rowValues, rowValues)
    }
    this.#next += at.length
  }

  /** The partial bucket of `level`, as latkit expects a level's last entry: each row's minimum and
   *  maximum over every frame since the last full bucket, including finer partial buckets.
   *  Undefined when every frame is in a full bucket. */
  tail(level: number): VisualizationRun | undefined {
    const stride = 8 ** level
    if (level < 1 || this.#next % stride === 0) return undefined
    const low = new Float32Array(this.rows).fill(Infinity)
    const high = new Float32Array(this.rows).fill(-Infinity)
    let [start, end] = [Infinity, -Infinity]
    for (let finer = level; finer >= 1; finer--) {
      const bucket = this.#levels[finer]
      if (!bucket) continue
      start = Math.min(start, bucket.start)
      end = Math.max(end, bucket.end)
      for (let row = 0; row < this.rows; row++) {
        low[row] = Math.min(low[row]!, bucket.low[row]!)
        high[row] = Math.max(high[row]!, bucket.high[row]!)
      }
    }
    return {
      level,
      first: Math.floor(this.#next / stride),
      at: Float64Array.of(start, end),
      values: bounds(this.rows, low, high),
    }
  }

  snapshot(): PyramidState {
    return {
      rows: this.rows,
      next: this.#next,
      levels: Array.from(this.#levels, (bucket) =>
        bucket
          ? {
              ...bucket,
              low: Array.from(bucket.low, (value) => (Number.isFinite(value) ? value : null)),
              high: Array.from(bucket.high, (value) => (Number.isFinite(value) ? value : null)),
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
      }
    })
    this.#levels.push(...levels)
    this.#next = state.next
  }

  /** Adds child `child` (a finer bucket, or a frame) to `level`'s partial bucket. */
  #add(
    level: number,
    child: number,
    start: number,
    end: number,
    low: Float32Array,
    high: Float32Array,
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
      }
      this.#levels[level] = bucket
    }
    if (bucket.index !== index) throw new Error('Pyramid input skipped a bucket.')
    bucket.end = end
    bucket.count++
    for (let row = 0; row < this.rows; row++) {
      if (Number.isFinite(low[row])) bucket.low[row] = Math.min(bucket.low[row]!, low[row]!)
      if (Number.isFinite(high[row])) bucket.high[row] = Math.max(bucket.high[row]!, high[row]!)
    }
    if (bucket.count !== 8) return
    this.#levels[level] = undefined
    this.emit({
      level,
      first: bucket.index,
      at: Float64Array.of(bucket.start, bucket.end),
      values: bounds(this.rows, bucket.low, bucket.high),
    })
    this.#add(level + 1, bucket.index, bucket.start, bucket.end, bucket.low, bucket.high)
  }
}
