import type { Domain, FieldRef } from '@latkit/model'
import type { Options } from '@latkit/monitor'

import type { Capabilities } from '../menus.js'
import type { CaseTarget, Selection } from '../targets.js'
import { isCaseTarget, isField, isSelection, record } from '../targets.js'
import type { TimeState } from '../timeline.js'
export type Appearance = Pick<Options, 'lineWidthPx' | 'focusColor' | 'unselectedAlpha'>
export interface PlotPreferences {
  field: FieldRef
  valueRange?: Domain
  appearance?: Appearance
}
export type SignalAction = 'signalElements' | 'runSolver' | 'showSolverOutput'
export interface LaneState {
  field: FieldRef
  label: string
  unit?: string
  recordedCount: number
  elementCount: number
  frameCount: number
  status: string
  action?: { command: SignalAction; label: string }
  range: readonly [number, number]
  colorRange?: readonly [number, number]
  colormap?: string
  valueRange: Domain
  appearance?: Appearance
  capabilities: Capabilities
}
export interface MonitorState {
  type: 'monitor'
  sourceId?: string
  timeRange: Domain | null
  target?: CaseTarget
  name: string
  status: string
  events?: { time: number; label: string }[]
  clock?: TimeState
  fields: LaneState[]
  time: number
  selection: Selection | null
}
export type ToMonitor =
  | MonitorState
  | {
      type: 'cursor'
      clock?: TimeState
      target: CaseTarget
      time: number
      selection: Selection | null
      label?: string
      values?: Record<string, number>
    }
  | { type: 'retry'; target: CaseTarget; field?: FieldRef }
export type Request =
  | { type: 'ready' }
  | { type: 'focus' }
  | { type: 'select'; target: CaseTarget; selection: Selection; time: number; frame?: number }
  | { type: 'step'; target: CaseTarget; direction: -1 | 1 }
  | { type: 'seek'; target: CaseTarget; time: number }
  | { type: 'window'; target: CaseTarget; range: Domain | null }
  | { type: 'toggle'; target: CaseTarget }
  | { type: 'action'; target: CaseTarget; field: FieldRef; command: SignalAction }
export function isRequest(value: unknown): value is Request {
  if (!record(value)) return false
  if (value.type === 'ready' || value.type === 'focus') return true
  if (!isCaseTarget(value.target)) return false
  if (value.type === 'action')
    return (
      isField(value.field) &&
      ['signalElements', 'runSolver', 'showSolverOutput'].includes(value.command as string)
    )
  if (value.type === 'window')
    return (
      value.range === null ||
      (Array.isArray(value.range) &&
        value.range.length === 2 &&
        value.range.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
        value.range[0] < value.range[1])
    )
  if (value.type === 'step') return value.direction === -1 || value.direction === 1
  if (
    value.frame !== undefined &&
    (!Number.isSafeInteger(value.frame) || (value.frame as number) < 0)
  )
    return false
  if (value.type === 'toggle') return true
  if (typeof value.time !== 'number' || !Number.isFinite(value.time)) return false
  return value.type === 'seek' || (value.type === 'select' && isSelection(value.selection))
}
