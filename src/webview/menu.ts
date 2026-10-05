/** The case's elements as the views find them and offer them to VS Code's native menu. */

import { type Data, type Item, rowAt, selectRows } from '@latkit/model'

import { menuContext, type Target } from '../shared/contexts.js'
import type { Element, Plot, ViewState } from '../shared/messages.js'
import { elementType } from '../shared/schema.js'

/** The item of element `id` in `source`; undefined when its type has no table. Throws for an id
 *  the table lacks. */
export function itemOf(source: Data, id: string): Item | undefined {
  const table = source.tables[elementType(id)]
  if (!table) return undefined
  return {
    source,
    index: table.index,
    row: rowAt(selectRows(table, { kind: 'ids', ids: [id] }), 0),
  }
}

/** Opens VS Code's menu for `elements` at `point`. Latkit picks asynchronously, so a synthetic
 *  event on a temporary node carries the exact hit's context. */
export function nativeMenu(
  canvas: HTMLCanvasElement,
  point: readonly [number, number],
  elements: Element[],
  state: ViewState,
  origin: Target['origin'],
  plot?: Plot,
) {
  if (!state.summary || state.stale) return
  const node = document.createElement('div')
  node.dataset.vscodeContext = JSON.stringify(
    menuContext(
      state.summary,
      {
        uri: state.summary.uri,
        version: state.summary.version,
        origin,
        element: elements[0],
        items: elements,
        type: plot?.from,
        field: plot?.field,
        plot,
      },
      state.bindings,
    ),
  )
  document.body.append(node)
  const bounds = canvas.getBoundingClientRect()
  node.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: bounds.left + point[0],
      clientY: bounds.top + point[1],
    }),
  )
  node.remove()
}
