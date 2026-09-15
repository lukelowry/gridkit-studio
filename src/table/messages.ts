import type { GridSort } from '@latkit/model'

import type { Capabilities } from '../menus.js'
import type { CaseTarget, Selection } from '../targets.js'
import { isCaseTarget, isSelection, record } from '../targets.js'
import type { TableColumn } from './columns.js'
export interface TableSettings {
  query: string
  sort: GridSort | null
  scrollTop: number
  visible?: string[]
  widths: Record<string, number>
}
export const defaults = (): TableSettings => ({ query: '', sort: null, scrollTop: 0, widths: {} })
export interface TableState {
  type: 'table'
  time?: number
  tick?: number
  target?: CaseTarget
  name: string
  status: string
  classId: string
  classLabel: string
  grid?: string
  columns: readonly (TableColumn & { bindable: boolean; bound: boolean })[]
  capabilities: Capabilities
  selection: Selection | null
  settings: TableSettings
  settingsVersion: number
}
export type Request =
  | { type: 'ready' }
  | { type: 'focus' }
  | { type: 'filter'; target: CaseTarget }
  | { type: 'select'; target: CaseTarget; selection: Selection | null }
  | {
      type: 'view'
      target: CaseTarget
      grid: string
      settingsVersion: number
      settings: TableSettings
    }
export function isSettings(value: unknown): value is TableSettings {
  return (
    record(value) &&
    typeof value.query === 'string' &&
    value.query.length <= 10000 &&
    typeof value.scrollTop === 'number' &&
    Number.isFinite(value.scrollTop) &&
    value.scrollTop >= 0 &&
    (value.visible === undefined ||
      (Array.isArray(value.visible) && value.visible.every((id) => typeof id === 'string'))) &&
    record(value.widths) &&
    Object.values(value.widths).every(
      (width) => typeof width === 'number' && Number.isFinite(width) && width >= 70 && width <= 800,
    ) &&
    (value.sort === null ||
      (record(value.sort) &&
        (value.sort.column === null || typeof value.sort.column === 'string') &&
        ['asc', 'desc'].includes(String(value.sort.dir))))
  )
}
export function isRequest(value: unknown): value is Request {
  if (!record(value)) return false
  if (value.type === 'ready' || value.type === 'focus') return true
  if (!isCaseTarget(value.target)) return false
  if (value.type === 'filter') return true
  if (value.type === 'select') return value.selection === null || isSelection(value.selection)
  if (typeof value.grid !== 'string' || !Number.isSafeInteger(value.settingsVersion)) return false
  return value.type === 'view' && isSettings(value.settings)
}
