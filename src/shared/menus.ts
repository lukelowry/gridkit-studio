/** What Studio's menus are opened on, and the context keys that place their items. */

import {
  type Entity,
  type Field,
  fieldDefinition,
  networkRole,
  referenceFields,
  tableDefinition,
} from './document.js'
import { channelsOf, type Mappings, NUMERIC } from './mappings.js'
import type { Plot, Revision, Summary } from './messages.js'

/** What a menu acts on: a whole element, one value of it, a column of the Case panel, or a plot. */
type Scope = 'element' | 'value' | 'column' | 'plot'

/** What a menu was opened on; its commands act on exactly this. */
export interface Target extends Revision {
  origin: 'network' | 'case' | 'monitor' | 'signals'
  /** The element under the pointer, when one is. */
  element?: Entity
  /** The field it names: a cell's or a column's, a plot's, or a signal's. */
  field?: Field
  /** Every element under the pointer. */
  items?: Entity[]
  plot?: Plot
}

/** The Case panel's own view of its rows, which its menus change: the column it sorts by, and
 *  whether a filter hides rows. */
interface Rows {
  sort?: { field: string; direction: 'ascending' | 'descending' }
  filtered?: boolean
}

/** The words a Monitored Signals row's `contextValue` holds, which its menu items match: it is a
 *  field, the case records it, a network channel can show it, and one does. */
const SIGNAL_WORDS = ['field', 'recorded', 'mappable', 'mapped'] as const

/** A Monitored Signals field row's `contextValue`. */
export function signalContext(
  has: Record<Exclude<(typeof SIGNAL_WORDS)[number], 'field'>, boolean>,
) {
  return SIGNAL_WORDS.filter((word) => word === 'field' || has[word]).join(' ')
}

/** Whether a network channel can show `field`, and whether one does. */
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

/** VS Code context keys for a menu on `target`, which carry the target to its commands; opening a
 *  menu never selects another row. Every view's menus take these keys, and only these. */
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
    gridkitTarget: target,
    gridkitOrigin: target.origin,
    gridkitScope: scope,
    gridkitElement: !!target.element,
    // A reference field, or, for a whole element, any it has: what Go to Referenced Element follows.
    gridkitReference: field
      ? definition?.kind === 'reference'
      : !!type && referenceFields(summary.definition, type).length > 0,
    gridkitScalar:
      NUMERIC.has(definition?.kind) ||
      definition?.kind === 'text' ||
      definition?.kind === 'boolean',
    gridkitSampled:
      !!type &&
      tableDefinition(summary.definition, type)?.fields.some((spec) => spec.kind === 'sampled'),
    gridkitMappable: mappable,
    gridkitMapped: mapped,
    gridkitOverlapping: (target.items?.length ?? 0) > 1,
    gridkitSort: field && rows.sort?.field === field.field ? rows.sort.direction : '',
    gridkitFiltered: !!rows.filtered,
  }
}
