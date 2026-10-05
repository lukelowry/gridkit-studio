/** Mount the block diagram and find elements in it. */

import { createDiagram, type Diagram, type DiagramConfig, type DiagramItem } from '@latkit/diagram'
import type { Gpu } from '@latkit/gpu'
import { type Data, itemId, rowAt, rowCount } from '@latkit/model'

import { message } from '../../shared/format.js'
import type { Element, ViewState } from '../../shared/messages.js'
import { diagramOf, elementType, placementOf } from '../../shared/schema.js'
import { bridge } from '../bridge.js'
import { itemOf, nativeMenu } from '../menu.js'
import { editing } from './edit.js'

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

/** The diagram on `canvas`, telling `select` of the element the user picks and `open` of the one
 *  they open. */
export function mountDiagram(
  gpu: Gpu,
  canvas: HTMLCanvasElement,
  config: Omit<DiagramConfig, 'canvas'>,
  state: () => ViewState,
  select: (element: Element | null) => void,
  open: (element: Element) => void,
): Diagram {
  const diagram = createDiagram(gpu, { ...config, canvas })
  const pick = (item: DiagramItem | undefined, then: (element: Element) => void) => {
    const element = item ? elementOf(item) : null
    if (element) then(element)
  }
  diagram.on('select', (items) => select(items[0] ? elementOf(items[0]) : null))
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
  const lifetime = new AbortController()
  const signal = AbortSignal.any([lifetime.signal, gpu.signal])
  const arrange = editing(diagram, gpu, state, signal)
  const notify = (error: unknown) => {
    if (!signal.aborted) bridge.send({ kind: 'notify', message: message(error) })
  }
  const stop = bridge.on((message) => {
    if (message.kind !== 'action') return
    if (message.command === 'diagramEditing' && message.value === true) {
      // Start at the selection, or else the first wired block.
      const item = diagramItem(diagram, state().selection) ?? firstWired(diagram)
      if (item) {
        pick(item, select)
        diagram.fit(diagram.neighborhood(item), { animate: false })
      }
    }
    if (message.command === 'arrangeDiagram') void arrange().catch(notify)
  })
  const destroy = diagram.destroy.bind(diagram)
  diagram.destroy = () => {
    lifetime.abort()
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
  const { source } = diagram.config
  const placement = placementOf(diagramOf(source.schema), elementType(element.id))
  if (!placement) return undefined
  const item = itemOf(source, element.id)
  if (!item) return undefined
  return element.field?.startsWith('ports.')
    ? { kind: 'port', ...item, port: element.field }
    : { kind: placement, ...item }
}
