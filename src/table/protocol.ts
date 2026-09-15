import type { ClassData, GridWindow } from '@latkit/model'
import { protocol } from '@latkit/port'

import { record } from '../targets.js'
import type { QuerySpec, ViewInfo } from './query.js'

export type TableRequest =
  | { type: 'query'; view: string; spec: QuerySpec }
  | { type: 'read'; view: string; offset: number; count: number; columns: readonly number[] }
  | { type: 'locate'; view: string; element: number }
  | { type: 'release'; view: string }
export type TableReply =
  | { type: 'view'; value: ViewInfo }
  | { type: 'rows'; value: GridWindow }
  | { type: 'position'; value: number | null }
  | { type: 'released' }
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
export function isTableRequest(value: unknown): value is TableRequest {
  if (!record(value)) return false
  if (value.type === 'query') {
    if (typeof value.view !== 'string') return false
    const spec = value.spec
    if (!record(spec) || typeof spec.filter !== 'string' || spec.filter.length > 10000) return false
    return (
      (spec.time === undefined || (typeof spec.time === 'number' && Number.isFinite(spec.time))) &&
      (spec.frame === undefined || integer(spec.frame)) &&
      (spec.frameCount === undefined || integer(spec.frameCount)) &&
      (spec.sort === null ||
        (record(spec.sort) &&
          (spec.sort.column === null || typeof spec.sort.column === 'string') &&
          (spec.sort.dir === 'asc' || spec.sort.dir === 'desc')))
    )
  }
  if (typeof value.view !== 'string') return false
  if (value.type === 'release') return true
  if (value.type === 'locate') return integer(value.element)
  return (
    value.type === 'read' &&
    integer(value.offset) &&
    integer(value.count) &&
    value.count <= 4096 &&
    Array.isArray(value.columns) &&
    value.columns.length <= 512 &&
    value.columns.every((i) => Number.isInteger(i) && i >= -1)
  )
}
export const tableProtocol = (id: string) =>
  protocol<TableRequest, TableReply>('gridkit.table.' + id, isTableRequest)
/** Worker-only registration. Case data is copied once; its model-owned buffers stay borrowed. */
export const openTableProtocol = protocol<
  {
    id: string
    data: ClassData
    recorded: readonly { id: string; elements: Uint32Array; columns: Uint32Array }[]
  },
  null
>('gridkit.table.open')
