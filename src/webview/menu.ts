import type { Entity } from '../shared/document.js'
import { menuContext, type Target } from '../shared/menus.js'
import type { Monitor, ViewState } from '../shared/messages.js'

/** The context keys for a menu in a view: on an element, a monitor, both, or neither (the
 *  Monitor's list). */
export function contextOf(
  state: ViewState,
  origin: Target['origin'],
  element?: Entity,
  monitor?: Monitor,
) {
  if (!state.summary || state.stale) return undefined
  return menuContext(
    state.summary,
    {
      uri: state.summary.uri,
      version: state.summary.version,
      origin,
      ...(element && { element }),
      ...(monitor && { field: { table: monitor.table, field: monitor.field }, monitor }),
    },
    { mappings: state.mappings, monitors: state.shown, listed: state.monitors },
  )
}

/** Opens VS Code's menu at `point` in `target`. latkit picks asynchronously, so a synthetic event
 *  on a temporary node carries the hit's context. */
export function nativeMenu(
  target: HTMLElement,
  point: readonly [number, number],
  context: ReturnType<typeof contextOf>,
) {
  if (!context) return
  const node = document.createElement('div')
  node.dataset.vscodeContext = JSON.stringify(context)
  document.body.append(node)
  const bounds = target.getBoundingClientRect()
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
