/** Present command parameters as form rows; validation and execution remain with the study and model. */

import type { Parameter } from '@latkit/model'

/** What the runs to come record: each type's fields. */
export type Monitored = Readonly<Record<string, readonly string[]>>

/** A choice in a dropdown row: the text a pick enters, and what the row shows for it. */
export interface Choice {
  readonly value: string
  readonly label: string
}

/** One parameter as its row shows it. */
export interface Row {
  /** The parameter's name, which names the control `field-<name>` for its label, its note and tests. */
  readonly key: string
  readonly label: string
  /** A text field, or a dropdown over `choices`. */
  readonly control: 'text' | 'select'
  /** The row's tooltip. */
  readonly description: string
  /** Shown after the label, and read as part of the control's name; empty for none. */
  readonly unit: string
  readonly required: boolean
  readonly placeholder: string
  /** The on-screen keyboard a text field asks for. */
  readonly inputmode: 'decimal' | 'numeric' | 'text'
  /** A list takes its own line under the label. */
  readonly stack: boolean
  readonly choices: readonly Choice[]
}

/** What the form calls the parameter named `name`. */
export const labelOf = (name: string, parameter: Parameter): string => parameter.label ?? name

/** The row for the parameter named `name`; `elements` are the choices of a reference parameter's
 *  type. */
export function rowOf(name: string, parameter: Parameter, elements: readonly Choice[]): Row {
  const list = parameter.multiple === true
  return {
    key: name,
    label: labelOf(name, parameter),
    control:
      (parameter.type === 'choice' || parameter.type === 'reference') && !list ? 'select' : 'text',
    description: parameter.description ?? '',
    unit: parameter.unit ?? '',
    required: parameter.optional !== true,
    placeholder: list ? 'Values separated by commas' : '',
    inputmode:
      parameter.type !== 'number' ? 'text' : parameter.integer === true ? 'numeric' : 'decimal',
    stack: list,
    choices:
      parameter.type === 'choice'
        ? parameter.choices.map((choice) => ({ value: choice, label: choice }))
        : parameter.type === 'reference'
          ? elements
          : [],
  }
}
