/** Command parameters as form rows. */

import type { Parameter } from '@latkit/model'

/** A dropdown entry: the text a pick enters, and the label shown for it. */
export interface Choice {
  readonly value: string
  readonly label: string
}

/** One parameter as its row shows it. */
export interface Row {
  /** The parameter name; the control's id and test id are `field-<key>`. */
  readonly key: string
  readonly label: string
  readonly control: 'text' | 'select'
  /** The row's tooltip. */
  readonly description: string
  /** Empty for none. */
  readonly unit: string
  readonly required: boolean
  /** The on-screen keyboard a text field asks for. */
  readonly inputmode: 'decimal' | 'numeric'
  readonly choices: readonly Choice[]
}

export const labelOf = (name: string, parameter: Parameter): string => parameter.label ?? name

/** The row for `parameter`; `elements` are the choices of a reference parameter. */
export function rowOf(name: string, parameter: Parameter, elements: readonly Choice[]): Row {
  return {
    key: name,
    label: labelOf(name, parameter),
    control: parameter.type === 'choice' || parameter.type === 'reference' ? 'select' : 'text',
    description: parameter.description ?? '',
    unit: parameter.unit ?? '',
    required: parameter.optional !== true,
    inputmode: parameter.type === 'number' && parameter.integer === true ? 'numeric' : 'decimal',
    choices:
      parameter.type === 'choice'
        ? parameter.choices.map((choice) => ({ value: choice, label: choice }))
        : parameter.type === 'reference'
          ? elements
          : [],
  }
}
