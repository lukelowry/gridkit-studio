/** Convert form values into command arguments and validate required values and bounds. */

import type { InputValue, Parameter } from '@latkit/model'

import { formatNumber } from '../format.js'

/** The pieces of a typed list: separated by commas or spaces. */
const pieces = (text: string): string[] => text.split(/[\s,]+/).filter((piece) => piece !== '')

/** The value `text` enters for `parameter`; undefined when it is empty. */
export function valueOf(parameter: Parameter, text: string): InputValue | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || parameter.type === 'file' || parameter.type === 'boolean') return undefined
  if (parameter.type === 'number')
    return parameter.multiple ? pieces(trimmed).map(Number) : Number(trimmed)
  return parameter.multiple ? pieces(trimmed) : trimmed
}

/** The text a field shows for `value`. */
export function textOf(value: InputValue | undefined): string {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.map((item) => textOf(item as InputValue)).join(', ')
  if (typeof value === 'number') return formatNumber(value)
  if (value instanceof File) return value.name
  return String(value)
}

/** What can never do about `value` for `parameter`, which the form calls `label`; null when the
 *  model may take it. */
export function problemOf(
  parameter: Parameter,
  label: string,
  value: InputValue | undefined,
): string | null {
  const empty =
    value === undefined || value === null || (Array.isArray(value) && value.length === 0)
  if (empty) return parameter.optional === true ? null : `${label} is required.`
  if (parameter.type !== 'number') return null
  for (const number of Array.isArray(value) ? value : [value]) {
    if (typeof number !== 'number' || !Number.isFinite(number)) return 'Enter a number.'
    if (parameter.integer === true && !Number.isSafeInteger(number)) return 'Enter a whole number.'
    if (parameter.min !== undefined && number < parameter.min)
      return `Enter a number at least ${formatNumber(parameter.min)}.`
    if (parameter.max !== undefined && number > parameter.max)
      return `Enter a number at most ${formatNumber(parameter.max)}.`
  }
  return null
}
