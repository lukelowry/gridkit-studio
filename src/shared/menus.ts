/** Context menu targets and the context keys that place menu items. */

import {
  type Entity,
  type Field,
  fieldDefinition,
  networkRole,
  tableDefinition,
} from './document.js'
import { channelsOf, type Mappings, NUMERIC } from './mappings.js'
import type { Plot, Revision, Summary } from './messages.js'

/** What a menu acts on: an element, one of its values, a Case panel column, or a plot. */
type Scope = 'element' | 'value' | 'column' | 'plot'

/** What a menu was opened on; its commands act on exactly this. */
export interface Target extends Revision {
  origin: 'network' | 'case' | 'monitor' | 'signals'
  element?: Entity
  /** The field of a cell, column, plot or signal. */
  field?: Field
  plot?: Plot
}

/** The Case panel's sort and filter state, which its menus change. */
interface Rows {
  sort?: { field: string; direction: 'ascending' | 'descending' }
  filtered?: boolean
}

/** The words in a Monitored Signals row's `contextValue` that its menu items match. */
const SIGNAL_WORDS = ['field', 'recorded', 'mappable', 'mapped'] as const

export function signalContext(
  has: Record<Exclude<(typeof SIGNAL_WORDS)[number], 'field'>, boolean>,
) {
  return SIGNAL_WORDS.filter((word) => word === 'field' || has[word]).join(' ')
}

/** Whether a Network channel can show `field`, and whether one does. */
export function mappingOf(
  { definition }: Pick<Summary, 'definition'>,
  mappings: Mappings,
  field: Field | undefined,
) {
  return {
    mappable:
      !!field &&
      !!networkRole(definition, field.table) &&
      NUMERIC.has(fieldDefinition(definition, field.table, field.field)?.kind),
    mapped: !!field && channelsOf(mappings, field).length > 0,
  }
}

/** The context keys for a menu on `target`, which also carry the target to its commands. Every
 *  webview menu sets exactly these keys, and opening a menu never changes the selection. */
export function menuContext(
  summary: Pick<Summary, 'definition'>,
  target: Target,
  mappings: Mappings = {},
  rows: Rows = {},
) {
  const { field } = target
  const type = field?.table ?? target.element?.table
  const definition = field && fieldDefinition(summary.definition, field.table, field.field)
  const scope: Scope = target.plot
    ? 'plot'
    : target.origin === 'case' && field
      ? target.element
        ? 'value'
        : 'column'
      : 'element'
  const { mappable, mapped } = mappingOf(summary, mappings, field)
  return {
    preventDefaultContextMenuItems: true,
    [TARGET]: target,
    'gridkitStudio.origin': target.origin,
    'gridkitStudio.scope': scope,
    'gridkitStudio.element': !!target.element,
    'gridkitStudio.scalar':
      NUMERIC.has(definition?.kind) ||
      definition?.kind === 'text' ||
      definition?.kind === 'boolean',
    'gridkitStudio.sampled':
      !!type &&
      tableDefinition(summary.definition, type)?.fields.some((spec) => spec.kind === 'sampled'),
    'gridkitStudio.mappable': mappable,
    'gridkitStudio.mapped': mapped,
    'gridkitStudio.sort': field && rows.sort?.field === field.field ? rows.sort.direction : '',
    'gridkitStudio.caseFiltered': !!rows.filtered,
  }
}

/** The context key that carries a menu's target to its commands. */
export const TARGET = 'gridkitStudio.target'

export const targetOf = (value: unknown): Target | undefined =>
  value && typeof value === 'object' && TARGET in value
    ? ((value as Record<typeof TARGET, Target>)[TARGET] ?? undefined)
    : undefined
