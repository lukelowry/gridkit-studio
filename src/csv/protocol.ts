import { protocol } from '@latkit/port'

import { record } from '../targets.js'
import { integer, MAX_COLUMNS, sampleBytes } from './limits.js'
export interface CsvInfo {
  headers: string[]
  rows: number
  range: [number, number] | null
  bytes: number
  indexEntries: number
}
export interface Samples {
  time: Float64Array
  values: Float64Array
}
export type Query =
  | { type: 'extent'; columns: readonly number[] }
  | { type: 'scan'; final: boolean }
  | { type: 'locate'; time: number }
  | { type: 'bounds'; range: readonly [number, number]; frameCount: number }
  | { type: 'read'; frameOffset: number; frameCount: number; columns: readonly number[] }
export function isCsvQuery(value: unknown): value is Query {
  if (!record(value)) return false
  if (value.type === 'scan') return typeof value.final === 'boolean'
  if (value.type === 'locate') return typeof value.time === 'number' && Number.isFinite(value.time)
  if (value.type === 'bounds')
    return (
      Array.isArray(value.range) &&
      value.range.length === 2 &&
      value.range.every(Number.isFinite) &&
      value.range[0] <= value.range[1] &&
      integer(value.frameCount)
    )
  if (
    !Array.isArray(value.columns) ||
    value.columns.length > MAX_COLUMNS ||
    !value.columns.every((c) => Number.isSafeInteger(c) && c >= -1 && c !== 0)
  )
    return false
  if (value.type === 'extent') return value.columns.every((c) => c > 0)
  if (value.type !== 'read' || !integer(value.frameOffset) || !integer(value.frameCount))
    return false
  try {
    sampleBytes(value.frameCount, value.columns.length)
    return true
  } catch {
    return false
  }
}
export const csvProtocol = protocol<Query, CsvInfo | Samples | number | readonly [number, number]>(
  'gridkit.csv',
  isCsvQuery,
)
