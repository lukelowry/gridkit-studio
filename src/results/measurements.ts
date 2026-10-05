import type { ElementStats, Metric, Observation } from '../shared/analysis.js'

export function validateMetrics(metrics: readonly Metric[] = []) {
  if (new Set(metrics.map((m) => m.kind)).size !== metrics.length)
    throw new Error('Choose each measurement once.')
  for (const metric of metrics) {
    if (metric.kind === 'extrema' || metric.kind === 'initial-final') continue
    if (!Number.isFinite(metric.maxGapSeconds) || metric.maxGapSeconds <= 0)
      throw new Error('maxGapSeconds must be finite and positive.')
    if (metric.kind === 'threshold') {
      if (
        metric.durationMethod !== 'left-hold' ||
        (metric.lower === undefined && metric.upper === undefined) ||
        [metric.lower, metric.upper].some((v) => v !== undefined && !Number.isFinite(v)) ||
        (metric.lower !== undefined && metric.upper !== undefined && metric.lower > metric.upper)
      )
        throw new Error('Choose finite threshold bounds and the left-hold duration method.')
    } else if (metric.kind === 'settling') {
      if (
        !Number.isFinite(metric.after) ||
        !Number.isFinite(metric.holdSeconds) ||
        metric.holdSeconds <= 0 ||
        !Array.isArray(metric.band) ||
        metric.band.length !== 2 ||
        !metric.band.every(Number.isFinite) ||
        metric.band[0] > metric.band[1]
      )
        throw new Error('Choose a finite settling time, ascending band and positive holdSeconds.')
    } else throw new Error('Unknown measurement.')
  }
}

/** One element's cross-page state; duplicate timestamps retain frame order but add no duration. */
export class Measurements {
  #previous?: { time: number; value: number | null }
  #outside = false
  #duration = 0
  #stable?: number
  readonly #threshold
  readonly #settling
  readonly #endpoints
  constructor(
    readonly result: ElementStats,
    metrics: readonly Metric[],
  ) {
    this.#threshold = metrics.find(
      (m): m is Extract<Metric, { kind: 'threshold' }> => m.kind === 'threshold',
    )
    this.#settling = metrics.find(
      (m): m is Extract<Metric, { kind: 'settling' }> => m.kind === 'settling',
    )
    this.#endpoints = metrics.some((m) => m.kind === 'initial-final')
    if (this.#endpoints) Object.assign(result, { initial: null, final: null })
    if (this.#threshold)
      result.threshold = {
        samples: 0,
        episodes: 0,
        estimatedSeconds: 0,
        longestSeconds: 0,
        coveredSeconds: 0,
        unknownSeconds: 0,
        firstAt: null,
        lastAt: null,
      }
    if (this.#settling) result.settling = { settledAt: null, observedThrough: null, heldSeconds: 0 }
  }
  add(time: number, frame: number, raw: number | null) {
    const value = raw !== null && Number.isFinite(raw) ? raw : null
    const previous = this.#previous
    const dt = previous ? time - previous.time : 0
    const observation: Observation | null = value === null ? null : { time, frame, value }
    if (this.#endpoints) {
      if (!previous) this.result.initial = observation
      this.result.final = observation
    }
    const threshold = this.#threshold
    const stats = this.result.threshold
    if (threshold && stats) {
      const connected =
        previous &&
        previous.value !== null &&
        value !== null &&
        dt >= 0 &&
        dt <= threshold.maxGapSeconds
      if (previous && dt > 0) {
        if (connected) {
          stats.coveredSeconds += dt
          if (this.#outside) {
            stats.estimatedSeconds += dt
            this.#duration += dt
            stats.longestSeconds = Math.max(stats.longestSeconds, this.#duration)
          }
        } else stats.unknownSeconds += dt
      }
      const outside =
        value !== null &&
        ((threshold.lower !== undefined && value < threshold.lower) ||
          (threshold.upper !== undefined && value > threshold.upper))
      if (outside) {
        stats.samples++
        stats.firstAt ??= time
        stats.lastAt = time
        if (!this.#outside || !connected) {
          stats.episodes++
          this.#duration = 0
        }
      } else this.#duration = 0
      this.#outside = outside
    }
    const settling = this.#settling
    const recovery = this.result.settling
    if (settling && recovery && time >= settling.after) {
      const inside = value !== null && value >= settling.band[0] && value <= settling.band[1]
      if (!inside) this.#stable = undefined
      else if (
        this.#stable === undefined ||
        !previous ||
        previous.value === null ||
        dt > settling.maxGapSeconds
      )
        this.#stable = time
      recovery.observedThrough = time
      recovery.heldSeconds = this.#stable === undefined ? 0 : time - this.#stable
      recovery.settledAt =
        this.#stable !== undefined && recovery.heldSeconds >= settling.holdSeconds
          ? this.#stable
          : null
    }
    this.#previous = { time, value }
  }
}
