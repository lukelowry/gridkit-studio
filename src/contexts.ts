import { type Bindings, NUMERIC } from './bindings.js'
import type { Element, Summary } from './messages.js'
import { diagramOf, networkOf, placementOf } from './schema.js'
const topology = new WeakMap<
  Summary['schema'],
  { network: ReturnType<typeof networkOf>; diagram: ReturnType<typeof diagramOf> }
>()
export interface Target {
  uri: string
  version: number
  origin: 'network' | 'diagram' | 'table' | 'monitor' | 'inspector' | 'signals'
  element?: Element
  type?: string
  field?: string
  items?: Element[]
  plot?: { from: string; field: string; id?: string }
}
/** Native menus receive this exact target; opening a menu never silently selects another row. */
export function menuContext(
  summary: Pick<Summary, 'schema' | 'editable'>,
  target: Target,
  bindings: Bindings = {},
) {
  const type = target.type ?? target.element?.id.split('/')[0]
  const field = target.field ?? target.element?.field
  const definition = type && field ? summary.schema.types[type]?.fields[field] : undefined
  let drawn = topology.get(summary.schema)
  if (!drawn)
    topology.set(
      summary.schema,
      (drawn = { network: networkOf(summary.schema), diagram: diagramOf(summary.schema) }),
    )
  const network = type ? placementOf(drawn.network, type) : null
  const diagram = type ? placementOf(drawn.diagram, type) : null
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
    gridkitReference: typeof definition?.type === 'object' && definition.type.kind === 'reference',
    gridkitBindable: !!network && NUMERIC.has(definition?.type),
    gridkitBound: Object.values(bindings).some(
      (binding) => binding.type === type && binding.field === field,
    ),
    gridkitRecorded: definition?.sampled === true,
    gridkitOverlapping: (target.items?.length ?? 0) > 1,
    gridkitPlot: !!target.plot,
    gridkitBus: !!type && !!summary.schema.types[type]?.spatial && network === 'vertex',
  }
}
