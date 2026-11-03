import type { Id, QueryResult } from 'latkit'

import type { Entity } from './document.js'

export type TimeRange = readonly [number, number]

export interface ProjectionSelection {
  readonly table: string
  readonly fields: readonly string[]
}

export interface ProjectionCursor {
  readonly phase: 'removals' | 'identities' | 'fields'
  readonly table: number
  readonly offset: number
}

export interface ProjectionPage {
  readonly base?: string
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
  readonly domain?: TimeRange
}

/** Authoritative scientific values, frame-major. */
export interface FrameBlock {
  readonly first: number
  readonly at: Float64Array
  readonly values: Float64Array
  readonly rows: number
}

/** A window of a recorded field: a plot's, across the device pixel columns it draws in, sent only
 *  what the window it holds (`since`, the key it was sent under) lacks where that is the same
 *  window grown; or the frames around the playhead a Network binding reads, within `bytes`. */
export type FrameRequest = {
  readonly results: string
  readonly table: string
  readonly field: string
  readonly ids?: readonly Id[]
  readonly range: TimeRange
} & (
  | { readonly purpose: 'plot'; readonly columns: number; readonly since?: string }
  | { readonly purpose: 'playhead'; readonly bytes: number }
)

export interface VisualizationRun {
  readonly level: number
  readonly first: number
  readonly at: Float64Array
  readonly values: Float32Array
}

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
