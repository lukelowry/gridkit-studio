import { createDiagram, type Diagram, type DiagramItem } from '@latkit/diagram'
import type { Gpu } from '@latkit/gpu'
import { type Data, itemId, rowAt, rowCount, type Schema, selectRows } from '@latkit/model'

import type { Element, ViewState } from '../messages.js'
import { bridge } from './bridge.js'
import { nativeMenu } from './context.js'
import { editing } from './diagram-edit.js'
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
export function mountDiagram(
  gpu: Gpu,
  canvas: HTMLCanvasElement,
  source: Data,
  style: object,
  state: () => ViewState,
) {
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
  diagram.on('contextmenu', (event) =>
    nativeMenu(
      canvas,
      event.point,
      event.items
        .filter((item) => item.kind !== 'group')
        .map((item) => ({
          id: itemId(item),
          ...(item.kind === 'port' ? { field: item.port } : {}),
        })),
      state(),
      'diagram',
    ),
  )
  const arrange = editing(diagram, gpu, state)
  const stop = bridge.on((message) => {
    if (
      message.kind === 'action' &&
      message.command === 'diagramEditing' &&
      message.value === true
    ) {
      let item = state().selection ? diagramItem(diagram, state().selection!) : undefined
      if (!item) {
        for (const type of diagramOf(diagram.config.source.schema).vertices) {
          const table = diagram.config.source.tables[type]
          if (!table || !rowCount(table.rows)) continue
          const candidate: DiagramItem = {
            kind: 'vertex',
            source: diagram.config.source,
            index: table.index,
            row: rowAt(table.rows, 0),
          }
          item ??= candidate
          if (diagram.neighborhood(candidate).length > 1) {
            item = candidate
            break
          }
        }
      }
      if (item) {
        select(item)
        diagram.fit(diagram.neighborhood(item), { animate: false })
      }
    }
    if (message.kind === 'action' && message.command === 'arrangeDiagram')
      void arrange().catch((error) => bridge.send({ kind: 'error', message: String(error) }))
  })
  const destroy = diagram.destroy.bind(diagram)
  diagram.destroy = () => {
    stop()
    destroy()
  }
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
