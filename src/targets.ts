import type { ElementRef, FieldRef } from '@latkit/model'

export interface CaseTarget {
  readonly uri: string
  readonly version: number
  readonly revision: string
}
export interface Selection {
  readonly element: ElementRef
  readonly field?: FieldRef
}
export interface Target extends CaseTarget {
  readonly element?: ElementRef
  readonly field?: FieldRef
  readonly items?: readonly ElementRef[]
}
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'
export const index = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0
export const isElement = (value: unknown): value is ElementRef =>
  record(value) && typeof value.classId === 'string' && index(value.index)
export const isField = (value: unknown): value is FieldRef =>
  record(value) &&
  typeof value.classId === 'string' &&
  typeof value.id === 'string' &&
  (value.source === 'column' || value.source === 'signal')
export const isCaseTarget = (value: unknown): value is CaseTarget =>
  record(value) &&
  typeof value.uri === 'string' &&
  index(value.version) &&
  typeof value.revision === 'string'
export function isTarget(value: unknown): value is Target {
  return (
    isCaseTarget(value) &&
    record(value) &&
    (value.element === undefined || isElement(value.element)) &&
    (value.field === undefined || isField(value.field)) &&
    (value.items === undefined ||
      (Array.isArray(value.items) && value.items.length <= 100 && value.items.every(isElement)))
  )
}
export const isSelection = (value: unknown): value is Selection =>
  record(value) &&
  isElement(value.element) &&
  (value.field === undefined ||
    (isField(value.field) && value.field.classId === value.element.classId))

/** Native menus pass their `data-vscode-context`; tree items carry their own frozen target. */
export function targetOf(argument: unknown): Target | undefined {
  const target = record(argument)
    ? (argument.gridkitTarget ?? argument.target ?? argument)
    : undefined
  return isTarget(target) ? target : undefined
}
