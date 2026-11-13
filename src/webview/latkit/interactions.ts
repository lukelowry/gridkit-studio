import type { Camera, Hit, View } from 'latkit'

import type { Entity } from '../../shared/document.js'

interface InteractionActions {
  select(element: Entity | null): void
  open(element: Entity): void
  menu(point: [number, number], elements: Entity[]): void
  camera(camera: Camera): void
  error(error: unknown): void
}

const elementOf = ({ row }: Hit): Entity => ({ table: row.table, id: row.id })

export function bindInteractions(view: View, actions: InteractionActions): () => void {
  const stop = [
    view.on('selection', ({ rows, trigger }) => {
      // Data that drops selected rows says so with no trigger: only a user gesture changes the
      // session's selection.
      if (!trigger) return
      const first = rows.find((group) => group.ids.length > 0)
      actions.select(first ? { table: first.table, id: first.ids[0]! } : null)
    }),
    view.on('open', ({ hit }) => actions.open(elementOf(hit))),
    view.on('menu', ({ hits, trigger }) => actions.menu(trigger.point, hits.map(elementOf))),
    view.on('camera', actions.camera),
    view.on('error', actions.error),
    // A scene of Studio's that draws an option as unset, or a mark not at all, is a defect.
    view.on('failures', ([failure]) => {
      if (failure) actions.error(failure)
    }),
  ]
  return () => {
    for (const unsubscribe of stop) unsubscribe()
  }
}
