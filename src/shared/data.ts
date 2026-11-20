import type { Id, QueryResult } from 'latkit'

import type { Entity } from './document.js'

/** A time range in seconds, start first. */
export type TimeRange = readonly [number, number]
/** A value range, lowest first. */
export type ValueRange = readonly [number, number]

export const isRange = (range: unknown): range is [number, number] =>
  Array.isArray(range) && range.length === 2 && range.every(Number.isFinite) && range[0] < range[1]

export interface FieldSelection {
  readonly table: string
  readonly fields: readonly string[]
}

export interface CaseRowsCursor {
  readonly phase: 'identities' | 'fields'
  readonly table: number
  readonly offset: number
  /** Suggested row count for the next page, based on the previous page's encoded size. */
  readonly count?: number
}

export interface CaseRowsPage {
  readonly key: string
  readonly bytes: Uint8Array
  readonly next?: CaseRowsCursor
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

/** A page of a table's rows from `offset`. A page requested around an `anchor` row starts a little
 *  before it, and reports whether the filters keep that row. */
export type TablePage = QueryResult & { readonly offset: number; readonly anchored?: boolean }

export interface RecordedField {
  readonly table: string
  readonly field: string
  readonly ids: readonly Id[]
  readonly domain?: ValueRange
}

/** One page of a mapped field's frames, for every row, from the frame at or before `range[0]`
 *  through the first frame after `range[1]`. */
export interface FrameRequest {
  readonly results: string
  readonly table: string
  readonly field: string
  readonly range: TimeRange
  /** Simulated seconds between frames the view displays (playback rate / frames per second). Only
   *  the last stored frame at or before each step from `range[0]` is sent. 0 sends every frame. */
  readonly step: number
}

/** A page of a field's frames as a standalone dataset named `source`: the time axis, every row,
 *  and frames up to PAGE_BYTES (at least one). The next page starts where this one ends. */
export interface FramePage {
  readonly source: string
  readonly table: string
  readonly field: string
  readonly bytes: Uint8Array
}

/** A time-tile file of a recorded field, as latkit's `Tiles` fetch them: the manifest, the base
 *  dataset of rows without samples, or tile `index` of `level`. */
export interface TileRequest {
  readonly results: string
  readonly table: string
  readonly field: string
  /** A single row to tile; without it, every recorded row. */
  readonly id?: Id
  readonly file: 'frames.json' | 'base.latk' | { readonly level: number; readonly index: number }
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

/** Target size of one page of table rows or frames. */
export const PAGE_BYTES = 4 * 1024 * 1024
