import type { Entity } from '../shared/document.js'
import { menuContext, type Target } from '../shared/menus.js'
import type { Plot, ViewState } from '../shared/messages.js'

/** Opens VS Code's menu for `element` at `point`. latkit picks asynchronously, so a synthetic
 *  event on a temporary node carries the hit's context. */
export function nativeMenu(
  canvas: HTMLCanvasElement,
  point: readonly [number, number],
  element: Entity | undefined,
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
        ...(element && { element }),
        ...(plot && { field: { table: plot.table, field: plot.field }, plot }),
      },
      state.mappings,
    ),
  )
  document.body.append(node)
  const bounds = canvas.getBoundingClientRect()
  // Cancelable like the browser's own, so an earlier handler can prevent VS Code's menu.
  node.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: bounds.left + point[0],
      clientY: bounds.top + point[1],
    }),
  )
  node.remove()
}
