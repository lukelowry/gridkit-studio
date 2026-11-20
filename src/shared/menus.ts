/** Context menu targets and the context keys that place menu items. */

import { type Entity, type Field, fieldDefinition, sameField, tableDefinition } from './document.js'
import { channelsOf, mappable, type Mappings, NUMERIC } from './mappings.js'
import type { Monitor, Revision, Summary } from './messages.js'

/** What a menu acts on: an element, one of its values, a Case panel column, a monitor, or the
 *  Monitor's list of them. */
type Scope = 'element' | 'value' | 'column' | 'monitor' | 'monitors'

/** What a menu was opened on; its commands act on exactly this. */
export interface Target extends Revision {
  origin: 'network' | 'case' | 'monitor'
  element?: Entity
  /** The field of a cell, column or monitor. */
  field?: Field
  monitor?: Monitor
}

/** What a menu's view shows besides the target: the Case panel's sort and filter, and the
 *  monitors the Monitor shows and lists. */
interface Shown {
  mappings?: Mappings
  sort?: { field: string; direction: 'ascending' | 'descending' }
  filtered?: boolean
  monitors?: readonly Field[]
  listed?: readonly Field[]
}

/** Whether a Network channel can show `field`, and whether one does. */
export function mappingOf(
  { definition }: Pick<Summary, 'definition'>,
  mappings: Mappings,
  field: Field | undefined,
) {
  return {
    mappable: !!field && mappable(definition, field),
    mapped: !!field && channelsOf(mappings, field).length > 0,
  }
}

/** The context keys for a menu on `target`, which also carry the target to its commands. Every
 *  webview menu sets exactly these keys, and opening a menu never changes the selection. */
export function menuContext(
  summary: Pick<Summary, 'definition'>,
  target: Target,
  { mappings = {}, sort, filtered = false, monitors = [], listed = [] }: Shown = {},
) {
  const { field } = target
  const type = field?.table ?? target.element?.table
  const definition = field && fieldDefinition(summary.definition, field.table, field.field)
  const scope: Scope = target.monitor
    ? 'monitor'
    : target.origin === 'monitor' && !target.element
      ? 'monitors'
      : target.origin === 'case' && field
        ? target.element
          ? 'value'
          : 'column'
        : 'element'
  const { mappable, mapped } = mappingOf(summary, mappings, field)
  const shown = !!target.monitor && monitors.some((each) => sameField(each, target.monitor!))
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
    'gridkitStudio.sort': field && sort?.field === field.field ? sort.direction : '',
    'gridkitStudio.caseFiltered': filtered,
    'gridkitStudio.shown': shown,
    'gridkitStudio.split': shown && monitors.length > 1,
    // As the title bar's key of the same name: a monitor the Monitor lists but does not show.
    'gridkitStudio.canSplit': listed.some((each) => !monitors.some((one) => sameField(one, each))),
  }
}

/** The context key that carries a menu's target to its commands. */
export const TARGET = 'gridkitStudio.target'

export const targetOf = (value: unknown): Target | undefined =>
  value && typeof value === 'object' && TARGET in value
    ? ((value as Record<typeof TARGET, Target>)[TARGET] ?? undefined)
    : undefined
