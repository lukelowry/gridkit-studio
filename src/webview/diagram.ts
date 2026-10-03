import { createDiagram, type Diagram, type DiagramItem } from '@latkit/diagram'
import type { Gpu } from '@latkit/gpu'
import { type Data, itemId, rowAt, type Schema, selectRows } from '@latkit/model'

import type { Element } from '../messages.js'
import { bridge } from './bridge.js'
import { diagramOf, nameFieldOf, placementOf } from './topology.js'
export function diagramTopology(schema: Schema) {
  const drawn = diagramOf(schema)
  return {
    vertices: Object.fromEntries(
      drawn.vertices.map((type) => [type, { labels: nameFieldOf(schema, type) }]),
    ),
    edges: Object.fromEntries(
      drawn.edges.map(({ type }) => [type, { route: 'orthogonal' as const, arrows: true }]),
    ),
  }
}
export function mountDiagram(gpu: Gpu, canvas: HTMLCanvasElement, source: Data, style: object) {
  const diagram = createDiagram(gpu, {
    canvas,
    source,
    ...diagramTopology(source.schema),
    input: 'navigate',
    layout: { algorithm: 'layered', direction: 'right' },
    ...style,
  })
  const select = (item: DiagramItem | undefined) => {
    if (item && item.kind !== 'group')
      bridge.send({
        kind: 'select',
        element: { id: itemId(item), ...(item.kind === 'port' ? { field: item.port } : {}) },
      })
  }
  diagram.on('select', (items) => select(items[0]))
  diagram.on('open', (item) => {
    select(item)
    bridge.command('elementSource')
  })
  diagram.on('contextmenu', (event) => {
    select(event.items[0])
    bridge.send({
      kind: 'overlap',
      elements: event.items
        .filter((item) => item.kind !== 'group')
        .map((item) => ({
          id: itemId(item),
          ...(item.kind === 'port' ? { field: item.port } : {}),
        })),
    })
  })
  return diagram
}
export function diagramItem(diagram: Diagram, element: Element): DiagramItem | undefined {
  const type = element.id.split('/')[0]!
  const placement = placementOf(diagramOf(diagram.config.source.schema), type)
  if (!placement) return
  const source = diagram.config.source
  const table = source.tables[type]
  if (!table) return
  const row = rowAt(selectRows(table, { kind: 'ids', ids: [element.id] }), 0)
  return element.field?.startsWith('ports.')
    ? { kind: 'port', source, index: table.index, row, port: element.field }
    : { kind: placement, source, index: table.index, row }
}
