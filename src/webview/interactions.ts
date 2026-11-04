import type { Camera, Hit, View } from 'latkit'

import type { Element } from '../shared/document.js'

interface InteractionActions {
  select(element: Element | null): void
  open(element: Element): void
  menu(point: [number, number], elements: Element[]): void
  camera(camera: Camera): void
  error(error: unknown): void
}

function elementOf(hit: Hit): Element {
  return { table: hit.row.table, id: hit.row.id, ...(hit.port ? { field: hit.port } : {}) }
}

export function bindInteractions(view: View, actions: InteractionActions): () => void {
  const stop = [
    view.on('selection', ({ rows, trigger }) => {
      // Data that drops selected rows says so with no trigger: only a user gesture changes the
      // session's selection.
      if (!trigger) return
      const first = rows.find((group) => group.ids.length > 0)
      actions.select(first ? { table: first.table, id: first.ids[0]! } : null)
    }),
    view.on('click', ({ hit }) => {
      if (hit.port) actions.select(elementOf(hit))
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
