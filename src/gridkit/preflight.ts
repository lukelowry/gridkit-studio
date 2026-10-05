/** The validation shared by simulation previews and execution. No processes or files are created. */
import { type Arguments, failure, type FieldSelection, type Parameters } from '@latkit/model'

import { BATCH_BYTES } from '../results/limits.js'
import type { Case } from './case.js'
import { diagnose } from './edits.js'
import { commandOf, parametersOf, selections } from './parameters.js'
import { faultRecords } from './staging.js'

export function preflight(
  kase: Case,
  input: Record<string, unknown>,
  selected: readonly FieldSelection[],
) {
  kase.checkSignals()
  const invalid = diagnose(kase).find((issue) => issue.severity === 'error')
  if (invalid) throw failure('invalid-input', `${invalid.id ?? 'Case'}: ${invalid.message}`)
  const parameters = parametersOf(kase.catalog)
  for (const name of Object.keys(input))
    if (!(name in parameters))
      throw failure('invalid-input', 'Unknown simulation parameter: ' + name)
  const values: Record<string, unknown> = {}
  for (const [name, parameter] of Object.entries(parameters)) {
    const value = input[name] ?? ('default' in parameter ? parameter.default : undefined)
    if (value === undefined && parameter.optional) continue
    const valid =
      parameter.type === 'number'
        ? typeof value === 'number' &&
          Number.isFinite(value) &&
          (!parameter.integer || Number.isInteger(value)) &&
          (parameter.min === undefined || value >= parameter.min) &&
          (parameter.max === undefined || value <= parameter.max)
        : parameter.type === 'boolean'
          ? typeof value === 'boolean'
          : parameter.type === 'choice'
            ? typeof value === 'string' && parameter.choices.includes(value)
            : typeof value === 'string'
    if (!valid) throw failure('invalid-input', `Invalid value for ${name}.`)
    values[name] = value
  }
  const command = commandOf(kase, values as Arguments<Parameters>)
  const outputs = selections(kase, selected)
  if (!outputs.length)
    throw failure('invalid-input', 'Choose at least one monitored signal to run.')
  const columns = outputs.reduce((n, field) => n + field.rows.length, 1)
  if (columns * 8 > BATCH_BYTES)
    throw failure('resource-limit', 'One selected frame exceeds 8 MiB.')
  const faults = faultRecords(kase, command.faults)
  return { values, command, outputs, faults, columns }
}
