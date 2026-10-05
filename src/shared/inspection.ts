import type { RowsQuery } from '@latkit/model'

import type { Revision } from './messages.js'

export interface CaseQuery extends Revision {
  from: string
  ids?: string[]
  where?: RowsQuery['where']
}
export interface AggregateQuery extends CaseQuery {
  fields: string[]
  groupBy?: string
  offset?: number
  limit?: number
}
export interface NeighborhoodQuery extends Revision {
  id: string
  network: 'electrical' | 'control'
  hops: number
  offset?: number
  limit?: number
}
export interface EvidencePage {
  evidence: string
  summary: Record<string, unknown>
  rows: unknown[]
  offset: number
  total: number
  nextOffset: number | null
}

export function pageOf(input: { offset?: number; limit?: number }) {
  const offset = input.offset ?? 0
  const limit = input.limit ?? 20
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1)
    throw new Error('Use a nonnegative offset and a positive limit.')
  return { offset, limit }
}
