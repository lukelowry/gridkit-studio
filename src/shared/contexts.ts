import { type Bindings, NUMERIC } from './bindings.js'
import type { Element, Plot, Revision, Summary } from './messages.js'
import {
  diagramOf,
  elementType,
  fieldOf,
  isReference,
  networkOf,
  placementOf,
  referencesOf,
} from './schema.js'

/** What a menu acts on: a whole element, one value of it, a column of the Case panel, or a plot. */
type Scope = 'element' | 'value' | 'column' | 'plot'

/** What a menu was opened on; its commands act on exactly this. */
export interface Target extends Revision {
  origin: 'network' | 'diagram' | 'case' | 'monitor' | 'signals'
  element?: Element
  type?: string
  field?: string
  /** Every element under the pointer. */
  items?: Element[]
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
export const SIGNAL_WORDS = ['field', 'recorded', 'mappable', 'mapped'] as const

/** A Monitored Signals field row's `contextValue`. */
export function signalContext(
  has: Record<Exclude<(typeof SIGNAL_WORDS)[number], 'field'>, boolean>,
) {
  return SIGNAL_WORDS.filter((word) => word === 'field' || has[word]).join(' ')
}

/** VS Code context keys for a menu on `target`, which carry the target to its commands; opening a
 *  menu never selects another row. Every view's menus take these keys, and only these. */
export function menuContext(
  summary: Pick<Summary, 'schema' | 'editable'>,
  target: Target,
  bindings: Bindings = {},
  rows: Rows = {},
) {
  const type = target.type ?? (target.element && elementType(target.element.id))
  const field = target.field ?? target.element?.field
  const definition = fieldOf(summary.schema, type, field)
  const network = type ? placementOf(networkOf(summary.schema), type) : null
  const diagram = type ? placementOf(diagramOf(summary.schema), type) : null
  const scope: Scope = target.plot
    ? 'plot'
    : target.origin === 'case' && field
      ? target.element
        ? 'value'
        : 'column'
      : 'element'
  const editable = type ? summary.editable[type] : undefined
  return {
    preventDefaultContextMenuItems: true,
    gridkitTarget: target,
    gridkitOrigin: target.origin,
    gridkitScope: scope,
    gridkitElement: !!target.element,
    gridkitPort: !!definition?.direction,
    gridkitNetwork: !!network,
    gridkitDiagram: !!diagram,
    // A whole element edits whichever of its fields the user picks.
    gridkitEditable:
      !!target.element && (field ? !!editable?.includes(field) : (editable?.length ?? 0) > 0),
    // A reference field, or, for a whole element, any it has: what Go to Referenced Element follows.
    gridkitReference: field
      ? isReference(definition)
      : !!type && referencesOf(summary.schema, type).length > 0,
    gridkitScalar:
      NUMERIC.has(definition?.type) ||
      definition?.type === 'text' ||
      definition?.type === 'boolean',
    gridkitSampled: Object.values((type && summary.schema.types[type]?.fields) || {}).some(
      (spec) => spec.sampled,
    ),
    gridkitBindable: !!network && NUMERIC.has(definition?.type),
    gridkitBound: Object.values(bindings).some(
      (binding) => binding.type === type && binding.field === field,
    ),
    gridkitOverlapping: (target.items?.length ?? 0) > 1,
    gridkitSort: field && rows.sort?.field === field ? rows.sort.direction : '',
    gridkitFiltered: !!rows.filtered,
  }
}
