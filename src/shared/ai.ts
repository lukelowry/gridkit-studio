import type { Value } from '@latkit/model'

import type { Metric } from './analysis.js'
import type { Program } from './messages.js'

export interface CaseReference {
  caseUri: string
  caseRevision: string
}

export interface MonitoredSignals {
  componentType: string
  fields: readonly string[]
  componentIds?: readonly string[]
  selectionId?: string
}

export interface SimulateInput {
  requestId: string
  caseUri: string
  caseRevision?: string
  program: Program
  parameters?: Record<string, number | string | boolean>
  recording?: readonly MonitoredSignals[]
}

export type CaseChange =
  | { kind: 'add'; componentType: string; key: string | number; fields: Record<string, Value> }
  | { kind: 'set'; componentId: string; field: string; value: Value }
  | { kind: 'remove'; componentIds: readonly string[] }
  | {
      kind: 'connect'
      from: { componentId: string; field: string }
      to: { componentId: string; field?: string } | null
    }
  | { kind: 'move'; componentId: string; position: readonly [number, number] | null }

export interface EditCaseInput extends CaseReference {
  requestId: string
  changes: readonly CaseChange[]
}

export interface SimulationTarget {
  simulationId: string
  contingencyIndex?: number
}

export interface AnalysisInput extends SimulationTarget {
  componentType: string
  field: string
  componentIds?: string[]
  selectionId?: string
  timeRange?: readonly [number, number]
  metrics?: readonly Metric[]
  order?: 'min' | 'max' | 'duration'
  waitMs?: number
  limit?: number
}

export interface Page<T> {
  items: readonly T[]
  total: number
  offset: number
  nextOffset: number | null
}

export function problem(code: string, message: string, details: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { code, ...details })
}

export interface ToolFailure {
  code: string
  message: string
  [detail: string]: unknown
}

/** Domain errors survive both adapters without leaking an implementation stack. */
export function toolProblem(error: unknown, aborted = false): ToolFailure {
  const value = error as Record<string, unknown> | null
  return {
    code: typeof value?.code === 'string' ? value.code : aborted ? 'cancelled' : 'operation-failed',
    message: error instanceof Error ? error.message : String(error),
    ...Object.fromEntries(
      [
        'issues',
        'componentId',
        'field',
        'expectedRevision',
        'actualRevision',
        'simulationId',
        'analysisId',
        'requestId',
        'changeId',
      ]
        .filter((key) => value?.[key] !== undefined)
        .map((key) => [key, value![key]]),
    ),
  }
}
