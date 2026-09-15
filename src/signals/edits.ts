import type { FieldRef } from '@latkit/model'
import { type Edit, modify } from 'jsonc-parser'

import type { Cases, ReadyCase } from '../case.js'
import { canonicalMonitor } from '../gridkit/classes.js'
import { classId } from '../gridkit/ids.js'
import { elementKey, indexElements } from '../gridkit/source.js'
import type { Bus, Case, Device } from '../gridkit/validate.js'

export function signalElements(raw: Case, id: string): readonly (Bus | Device)[] {
  return id === 'bus' ? raw.buses : raw.devices.filter((device) => classId(device.class) === id)
}
export function monitored(raw: Case, field: FieldRef): number[] {
  return signalElements(raw, field.classId).flatMap((element, index) =>
    element.mon?.some((name) => canonicalMonitor(element.class, name) === field.id) ? [index] : [],
  )
}
export interface MonitoringChange {
  field: FieldRef
  elements: readonly number[]
  enabled: boolean
}

export function monitoringEdits(text: string, changes: readonly MonitoringChange[]): Edit[] {
  const spans = indexElements(text)
  const next = new Map<
    string,
    { span: { offset: number; length: number }; mon: string[]; before: string[]; className: string }
  >()
  for (const change of changes) {
    if (change.field.source !== 'signal') throw new Error('Choose a simulation signal.')
    for (const index of change.elements) {
      const key = elementKey({ classId: change.field.classId, index })
      let element = next.get(key)
      if (!element) {
        const span = spans.get(key)
        if (!span) throw new Error('The monitored element no longer exists.')
        const raw = JSON.parse(text.slice(span.offset, span.offset + span.length))
        element = { span, mon: [...(raw.mon ?? [])], before: raw.mon ?? [], className: raw.class }
        next.set(key, element)
      }
      const enabled = element.mon.some(
        (name) => canonicalMonitor(element.className, name) === change.field.id,
      )
      if (enabled === change.enabled) continue
      element.mon = element.mon.filter(
        (name) => canonicalMonitor(element.className, name) !== change.field.id,
      )
      if (change.enabled) element.mon.push(change.field.id)
    }
  }
  return [...next.values()].flatMap(({ span, mon, before }) =>
    JSON.stringify(mon) === JSON.stringify(before)
      ? []
      : modify(text.slice(span.offset, span.offset + span.length), ['mon'], mon, {}).map(
          (edit) => ({ ...edit, offset: edit.offset + span.offset }),
        ),
  )
}

export function setElementSignals(
  cases: Cases,
  state: ReadyCase,
  id: string,
  next: ReadonlyMap<number, readonly string[]>,
): Promise<void> {
  const elements = signalElements(state.raw, id)
  const changes: MonitoringChange[] = []
  for (const [index, mon] of next) {
    const raw = elements[index]
    if (!raw) throw new Error('The monitored element no longer exists.')
    for (const name of new Set([...(raw.mon ?? []), ...mon])) {
      const field = {
        classId: id,
        source: 'signal' as const,
        id: canonicalMonitor(raw.class, name),
      }
      changes.push({
        field,
        elements: [index],
        enabled: mon.some((name) => canonicalMonitor(raw.class, name) === field.id),
      })
    }
  }
  return state.updateMonitoring(cases, state.inputKey!, changes)
}
export function setSignalElements(
  cases: Cases,
  state: ReadyCase,
  field: FieldRef,
  indices: readonly number[],
): Promise<void> {
  return state.updateMonitoring(cases, state.inputKey!, [
    { field, elements: signalElements(state.raw, field.classId).map((_, i) => i), enabled: false },
    { field, elements: indices, enabled: true },
  ])
}
