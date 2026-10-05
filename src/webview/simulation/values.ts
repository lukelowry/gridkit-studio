/** Parse, show and check form values. */

import type { InputValue, Parameter } from '@latkit/model'

import { formatNumber } from '../../shared/format.js'

/** `text` parsed for `parameter`; undefined when blank. */
export function valueOf(parameter: Parameter, text: string): InputValue | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  return parameter.type === 'number' ? Number(trimmed) : trimmed
}

/** The text a field shows for `value`. */
export function textOf(value: InputValue | undefined): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'number' ? formatNumber(value) : String(value)
}

/** Why `value` cannot run, with `label` naming it; null when it can. Exclusive bounds and rules
 *  across parameters are left to the worker. */
export function problemOf(
  parameter: Parameter,
  label: string,
  value: InputValue | undefined,
): string | null {
  if (value === undefined || value === null)
    return parameter.optional === true ? null : `${label} is required.`
  if (parameter.type !== 'number') return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number.'
  if (parameter.integer === true && !Number.isSafeInteger(value)) return 'Enter a whole number.'
  if (parameter.min !== undefined && value < parameter.min)
    return `Enter a number at least ${formatNumber(parameter.min)}.`
  if (parameter.max !== undefined && value > parameter.max)
    return `Enter a number at most ${formatNumber(parameter.max)}.`
  return null
}
