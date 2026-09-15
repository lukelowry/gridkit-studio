import { protocol } from '@latkit/port'
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
export const csvProtocol = protocol<Query, CsvInfo | Samples | number | readonly [number, number]>(
  'gridkit.csv',
)
