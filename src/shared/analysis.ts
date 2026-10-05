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
  order?: 'min' | 'max'
  limit?: number
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
}
export interface Comparison {
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
  }[]
}
