import type { SolverInput } from '../gridkit/solver.js'
import { index, record } from '../targets.js'
import type { FaultInput, FaultInterval } from './faults.js'

export type DraftValue =
  | { kind: 'settings'; values: Record<string, string> }
  | { kind: 'fault'; bus: number; on?: number; label: string; values: Record<string, string> }
export interface DraftState {
  id: string
  value: DraftValue
  stale: boolean
}
export interface SimulationState {
  type: 'state'
  owner: string
  revision: number
  caseName: string
  configuration: string
  input?: SolverInput
  draft?: DraftState
  faults: { interval: FaultInterval; value: FaultInput; label: string }[]
  events: { index: number; label: string }[]
  running: boolean
  notice: string
}
export type ToSimulation =
  | SimulationState
  | {
      type: 'result'
      owner: string
      draftId?: string
      ok: boolean
      message?: string
    }
export type Request =
  | { type: 'ready' }
  | { type: 'focus' }
  | { type: 'terminal'; owner: string }
  | { type: 'configuration'; owner: string }
  | { type: 'cancel'; owner: string; draftId: string }
  | { type: 'edit'; owner: string; revision: number; draftId: string; value: DraftValue }
  | { type: 'submit'; owner: string; draftId: string; value: DraftValue }
  | {
      type: 'select' | 'editEvent' | 'removeEvent' | 'removeFault'
      owner: string
      revision: number
      index: number
    }
function draft(value: unknown): value is DraftValue {
  return (
    record(value) &&
    record(value.values) &&
    Object.values(value.values).every((v) => typeof v === 'string') &&
    (value.kind === 'settings' ||
      (value.kind === 'fault' &&
        index(value.bus) &&
        typeof value.label === 'string' &&
        (value.on === undefined || index(value.on))))
  )
}
export function isRequest(value: unknown): value is Request {
  if (!record(value)) return false
  if (value.type === 'ready' || value.type === 'focus') return true
  if (typeof value.owner !== 'string') return false
  if (['terminal', 'configuration'].includes(String(value.type))) return true
  if (['cancel', 'edit', 'submit'].includes(String(value.type)))
    return (
      typeof value.draftId === 'string' &&
      (value.type === 'cancel' ||
        (draft(value.value) && (value.type !== 'edit' || index(value.revision))))
    )
  return (
    ['select', 'editEvent', 'removeEvent', 'removeFault'].includes(String(value.type)) &&
    index(value.revision) &&
    index(value.index)
  )
}
