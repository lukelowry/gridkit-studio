import type { Id, QueryResult } from 'latkit'

import type { Entity } from './document.js'

/** Times, in seconds, from the first to the last. */
export type TimeRange = readonly [number, number]
/** Values of a field, from the lowest to the highest. */
export type ValueRange = readonly [number, number]

/** Whether `range` is two finite numbers, the low first. */
export const isRange = (range: unknown): range is [number, number] =>
  Array.isArray(range) && range.length === 2 && range.every(Number.isFinite) && range[0] < range[1]

export interface ProjectionSelection {
  readonly table: string
  readonly fields: readonly string[]
}

export interface ProjectionCursor {
  readonly phase: 'identities' | 'fields'
  readonly table: number
  readonly offset: number
}

export interface ProjectionPage {
  readonly key: string
  readonly bytes: Uint8Array
  readonly next?: ProjectionCursor
}

export interface TableRequest {
  readonly anchor?: Id
  readonly table: string
  readonly fields: readonly string[]
  readonly ids?: readonly Id[]
  readonly offset: number
  readonly limit: number
  readonly search?: string
  readonly equal?: { readonly field: string; readonly value: string | number | boolean }
  readonly order?: { readonly field: string; readonly direction: 'ascending' | 'descending' }
}

export type TablePage = QueryResult & { readonly offset: number }

export interface RecordedField {
  readonly table: string
  readonly field: string
  readonly ids: readonly Id[]
  /** The values the results hold of it. */
  readonly domain?: ValueRange
}

/** A window of a recorded field: a plot's, across the device pixel columns it draws in, sent only
 *  what the window it holds (`since`, the key it was sent under) lacks where that is the same
 *  window grown; or the frames ahead of the playhead a field the Network maps reads, within `bytes`. */
export type FrameRequest = {
  readonly results: string
  readonly table: string
  readonly field: string
  readonly ids?: readonly Id[]
  readonly range: TimeRange
} & (
  | { readonly purpose: 'plot'; readonly columns: number; readonly since?: string }
  | {
      readonly purpose: 'playhead'
      readonly bytes: number
      /** Seconds of the run between the frames a view shows, the rate over the frames it shows a
       *  second: of the frames stored, those last at or before each such time from `range[0]` go,
       *  so no more frames go than show. 0 sends every frame stored. */
      readonly step: number
    }
)

export interface FramePage {
  readonly key: string
  readonly source: string
  readonly table: string
  readonly field: string
  readonly bytes: Uint8Array
  readonly complete: boolean
  /** The key of the window these pages go on top of, when they hold only what it lacks. */
  readonly base?: string
  readonly next?: string
}

export interface ExactSampleRequest extends Entity {
  readonly results: string
  readonly field: string
  readonly at: number
}

export interface ExactSample {
  readonly at: number
  readonly value: number | null
}

export const PAGE_BYTES = 4 * 1024 * 1024
export const ENTRY_BYTES = 16 * 1024 * 1024
/** The most frame pages a view keeps, and so the most a playhead window may hold. */
export const PAYLOAD_BYTES = 96 * 1024 * 1024
