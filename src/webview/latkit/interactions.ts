import type { Camera, Hit, View } from 'latkit'

import type { Entity } from '../../shared/document.js'

interface InteractionActions {
  select(element: Entity | null): void
  open(element: Entity): void
  /** A context menu at `point`, with the nearest element if one is in reach. */
  menu(point: [number, number], element: Entity | undefined): void
  camera(camera: Camera): void
  error(error: unknown): void
}

const elementOf = ({ row }: Hit): Entity => ({ table: row.table, id: row.id })

/** Forwards user input on `view` to `actions`; returns the unsubscribe. */
export function bindInteractions(
  view: View,
  canvas: HTMLCanvasElement,
  actions: InteractionActions,
): () => void {
  // VS Code's menu opens for what latkit finds under the pointer, not for the canvas.
  const stopNativeMenu = (event: Event) => event.stopPropagation()
  canvas.addEventListener('contextmenu', stopNativeMenu)
  const stop = [
    view.on('selection', ({ rows, trigger }) => {
      // Only a user gesture has a trigger and changes the session's selection, not data that
      // drops selected rows.
      if (!trigger) return
      const first = rows.find((group) => group.ids.length > 0)
      actions.select(first ? { table: first.table, id: first.ids[0]! } : null)
    }),
    view.on('open', ({ hit }) => actions.open(elementOf(hit))),
    // latkit lists the hits nearest first.
    view.on('menu', ({ hits: [nearest], trigger }) =>
      actions.menu(trigger.point, nearest && elementOf(nearest)),
    ),
    view.on('camera', actions.camera),
    view.on('error', actions.error),
    // An option drawn as unset, or a mark not drawn at all, is a defect in Studio's scene.
    view.on('failures', ([failure]) => {
      if (failure) actions.error(failure)
    }),
  ]
  return () => {
    canvas.removeEventListener('contextmenu', stopNativeMenu)
    for (const unsubscribe of stop) unsubscribe()
  }
}
