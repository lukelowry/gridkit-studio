import type { Domain } from '@latkit/model'

import type { Revision, RunInfo } from './messages.js'

/** A retained run, or a stable study id and zero-based contingency index. */
export interface RunTarget {
  uri: string
  run: string
  contingency?: number
}
export interface AnalysisOptions {
  from: string
  field: string
  ids?: string[]
  window?: Domain
  order?: 'min' | 'max' | 'duration'
  limit?: number
  selection?: string
  metrics?: readonly Metric[]
}
/** Duration is estimated from recorded samples; gaps are never treated as healthy data. */
export type Metric =
  | { kind: 'extrema' }
  | { kind: 'initial-final' }
  | {
      kind: 'threshold'
      lower?: number
      upper?: number
      durationMethod: 'left-hold'
      maxGapSeconds: number
    }
  | {
      kind: 'settling'
      after: number
      band: readonly [number, number]
      holdSeconds: number
      maxGapSeconds: number
    }
export interface ThresholdStats {
  samples: number
  episodes: number
  estimatedSeconds: number
  longestSeconds: number
  coveredSeconds: number
  unknownSeconds: number
  firstAt: number | null
  lastAt: number | null
}
export interface SettlingStats {
  settledAt: number | null
  observedThrough: number | null
  heldSeconds: number
}
export interface Observation {
  value: number
  time: number
  frame: number
}
export interface ElementStats {
  id: string
  valid: number
  missing: number
  min: Observation | null
  max: Observation | null
  initial?: Observation | null
  final?: Observation | null
  threshold?: ThresholdStats
  settling?: SettlingStats
}
export interface Analysis {
  run: string
  study?: string
  contingency?: number
  revision: Revision
  fingerprint: string
  state: RunInfo['state']
  snapshot: { pages: number; frames: number; domain: Domain }
  window: Domain
  from: string
  field: string
  unit: string | null
  total: number
  rows: ElementStats[]
  metrics?: readonly Metric[]
  population?: {
    measured: number
    unmeasured: number
    missingSamples: number
    affected?: number
    settled?: number
  }
  evidence?: string
}
export interface Comparison {
  evidence?: string
  before: Omit<Analysis, 'rows'>
  after: Omit<Analysis, 'rows'>
  matched: number
  onlyBefore: number
  onlyAfter: number
  rows: {
    id: string
    before: ElementStats
    after: ElementStats
    minDelta: number | null
    maxDelta: number | null
    durationDelta?: number | null
    newlyAffected?: boolean | null
    recovered?: boolean | null
  }[]
}

export interface SignalOptions extends RunTarget {
  from: string
  field: string
  ids: string[]
  window: Domain
  representation:
    { kind: 'exact'; maxSamples: number; offset?: number } | { kind: 'envelope'; buckets: number }
}
export interface SignalResult {
  run: string
  revision: Revision
  fingerprint: string
  snapshot: Analysis['snapshot']
  from: string
  field: string
  unit: string | null
  window: Domain
  representation: SignalOptions['representation']
  series: { id: string; samples: { time: number; frame: number; value: number | null }[] }[]
  nextOffset: number | null
}
