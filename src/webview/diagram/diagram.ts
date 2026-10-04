/** Create the case's block/net diagram and map element identities. */

import { createDiagram, type Diagram, type DiagramConfig, type DiagramItem } from '@latkit/diagram'
import type { Gpu } from '@latkit/gpu'
import { type Data, itemId, rowAt, rowCount, selectRows } from '@latkit/model'

import type { Element, ViewState } from '../../messages.js'
import { diagramOf, placementOf } from '../../schema.js'
import { bridge } from '../bridge.js'
import { nativeMenu } from '../menu.js'
import { editing } from './edit.js'

/** What a diagram renderer of `source` draws; how each type draws is its style. */
export function diagramData(source: Data): Pick<DiagramConfig, 'source' | 'vertices' | 'edges'> {
  const { vertices, edges } = diagramOf(source.schema)
  return {
    source,
    vertices: Object.fromEntries(vertices.map((type) => [type, {}])),
    edges: Object.fromEntries(edges.map(({ type }) => [type, {}])),
  }
}

/** Whether `source` has anything for a diagram to draw. */
export function diagrammed(source: Data): boolean {
  return diagramOf(source.schema).vertices.some((type) => {
    const rows = source.tables[type]?.rows
    return rows !== undefined && rowCount(rows) > 0
  })
}

/** The element a diagram item is: a port is a field of its block; a group is none. */
function elementOf(item: DiagramItem): Element | null {
  if (item.kind === 'group') return null
  return { id: itemId(item), ...(item.kind === 'port' && { field: item.port }) }
}

/** The case's diagram on `canvas`, styled before it can prepare its first frame. `select` hears of
 *  the element the reader picks, and `open` of the one they open. */
export function mountDiagram(
  gpu: Gpu,
  canvas: HTMLCanvasElement,
  source: Data,
  style: Parameters<Diagram['set']>[0],
  state: () => ViewState,
  select: (element: Element) => void,
  open: (element: Element) => void,
): Diagram {
  const diagram = createDiagram(gpu, { canvas, ...diagramData(source) })
  diagram.set(style)
  const pick = (item: DiagramItem | undefined, then: (element: Element) => void) => {
    const element = item ? elementOf(item) : null
    if (element) then(element)
  }
  diagram.on('select', (items) => pick(items[0], select))
  diagram.on('open', (item) => pick(item, open))
  diagram.on('contextmenu', (event) =>
    nativeMenu(
      canvas,
      event.point,
      event.items.map(elementOf).filter((element): element is Element => element !== null),
      state(),
      'diagram',
    ),
  )
  const arrange = editing(diagram, gpu, state)
  const stop = bridge.on((message) => {
    if (message.kind !== 'action') return
    if (message.command === 'diagramEditing' && message.value === true) {
      // Editing starts where there is something to edit: the selection, or the first wired block.
      const item = diagramItem(diagram, state().selection) ?? firstWired(diagram)
      if (item) {
        pick(item, select)
        diagram.fit(diagram.neighborhood(item), { animate: false })
      }
    }
    if (message.command === 'arrangeDiagram')
      void arrange().catch((error) => bridge.send({ kind: 'notify', message: String(error) }))
  })
  const destroy = diagram.destroy.bind(diagram)
  diagram.destroy = () => {
    stop()
    destroy()
  }
  return diagram
}

/** The first block wired to another, or else the first block. */
function firstWired(diagram: Diagram): DiagramItem | undefined {
  const source = diagram.config.source
  let first: DiagramItem | undefined
  for (const type of diagramOf(source.schema).vertices) {
    const table = source.tables[type]
    if (!table || !rowCount(table.rows)) continue
    const item: DiagramItem = {
      kind: 'vertex',
      source,
      index: table.index,
      row: rowAt(table.rows, 0),
    }
    first ??= item
    if (diagram.neighborhood(item).length > 1) return item
  }
  return first
}

/** The diagram item `element` is; undefined when the diagram does not draw its type. */
export function diagramItem(
  diagram: Diagram,
  element: Element | undefined,
): DiagramItem | undefined {
  if (!element) return undefined
  const source = diagram.config.source
  const type = element.id.split('/')[0]!
  const placement = placementOf(diagramOf(source.schema), type)
  const table = source.tables[type]
  if (!placement || !table) return undefined
  const rows = selectRows(table, { kind: 'ids', ids: [element.id] })
  if (!rowCount(rows)) return undefined
  const row = rowAt(rows, 0)
  return element.field?.startsWith('ports.')
    ? { kind: 'port', source, index: table.index, row, port: element.field }
    : { kind: placement, source, index: table.index, row }
}
