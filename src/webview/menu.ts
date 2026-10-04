import { menuContext, type Target } from '../shared/contexts.js'
import type { Element, Plot, ViewState } from '../shared/messages.js'
/** Latkit picks asynchronously; a separate element hands the exact hit to VS Code's native menu. */
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
