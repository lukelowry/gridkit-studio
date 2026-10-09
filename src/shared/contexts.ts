import type { Schema } from '@latkit/model'

import { type Bindings, NUMERIC } from './bindings.js'
import type { Element, Plot, Revision, Summary } from './messages.js'
import {
  diagramOf,
  type Drawn,
  elementType,
  isReference,
  networkOf,
  placementOf,
} from './schema.js'

/** What a menu acts on: a whole element, one value of it, a column of the Case panel, or a plot. */
export type Scope = 'element' | 'value' | 'column' | 'plot'

/** What a menu was opened on; its commands act on exactly this. */
export interface Target extends Revision {
  origin: 'network' | 'diagram' | 'case' | 'monitor'
  element?: Element
  type?: string
  field?: string
  /** Every element under the pointer. */
  items?: Element[]
  plot?: Plot
}

/** The Case panel's own view of its rows, which its menus change: the column it sorts by, and
 *  whether a filter hides rows. */
export interface Rows {
  sort?: { field: string; direction: 'ascending' | 'descending' }
  filtered?: boolean
}

const drawn = new WeakMap<Schema, { network: Drawn; diagram: Drawn }>()

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
  const definition = type && field ? summary.schema.types[type]?.fields[field] : undefined
  let views = drawn.get(summary.schema)
  if (!views)
    drawn.set(
      summary.schema,
      (views = { network: networkOf(summary.schema), diagram: diagramOf(summary.schema) }),
    )
  const network = type ? placementOf(views.network, type) : null
  const diagram = type ? placementOf(views.diagram, type) : null
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
    gridkitField: !!field,
    gridkitPort: !!definition?.direction,
    gridkitNetwork: !!network,
    gridkitDiagram: !!diagram,
    gridkitEdge: network === 'edge',
    // A whole element edits whichever of its fields the user picks.
    gridkitEditable:
      !!target.element && (field ? !!editable?.includes(field) : (editable?.length ?? 0) > 0),
    gridkitReference: isReference(definition),
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
    gridkitRecorded: definition?.sampled === true,
    gridkitOverlapping: (target.items?.length ?? 0) > 1,
    gridkitPlot: !!target.plot,
    gridkitBus: network === 'vertex',
    gridkitSort: field && rows.sort?.field === field ? rows.sort.direction : '',
    gridkitFiltered: !!rows.filtered,
  }
}
