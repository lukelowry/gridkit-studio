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

/** What a menu was opened on; its commands act on exactly this. */
export interface Target extends Revision {
  origin: 'network' | 'diagram' | 'case' | 'monitor' | 'inspector'
  element?: Element
  type?: string
  field?: string
  /** Every element under the pointer. */
  items?: Element[]
  plot?: Plot
}

const drawn = new WeakMap<Schema, { network: Drawn; diagram: Drawn }>()

/** VS Code context keys for a menu on `target`, which carry the target to its commands; opening a
 *  menu never selects another row. */
export function menuContext(
  summary: Pick<Summary, 'schema' | 'editable'>,
  target: Target,
  bindings: Bindings = {},
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
  return {
    preventDefaultContextMenuItems: true,
    gridkitTarget: target,
    gridkitOrigin: target.origin,
    gridkitElement: !!target.element,
    gridkitField: !!field,
    gridkitPort: !!definition?.direction,
    gridkitNetwork: !!network,
    gridkitDiagram: !!diagram,
    gridkitEdge: network === 'edge',
    gridkitEditable: !!(target.element && type && field && summary.editable[type]?.includes(field)),
    gridkitReference: isReference(definition),
    gridkitBindable: !!network && NUMERIC.has(definition?.type),
    gridkitBound: Object.values(bindings).some(
      (binding) => binding.type === type && binding.field === field,
    ),
    gridkitRecorded: definition?.sampled === true,
    gridkitOverlapping: (target.items?.length ?? 0) > 1,
    gridkitPlot: !!target.plot,
    gridkitBus: network === 'vertex',
  }
}
