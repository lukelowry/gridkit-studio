import type { Camera, Hit, View } from 'latkit'

import type { Element } from '../shared/document.js'

export interface InteractionActions {
  select(element: Element | null): void
  open(element: Element): void
  menu(point: [number, number], elements: Element[]): void
  camera(camera: Camera): void
  error(error: unknown): void
}

export function elementOf(hit: Hit): Element {
  return { table: hit.row.table, id: hit.row.id, ...(hit.port ? { field: hit.port } : {}) }
}

export function bindInteractions(view: View, actions: InteractionActions): () => void {
  const stop = [
    view.on('selection', ({ rows, trigger }) => {
      // Source replacement and application-driven selection also emit this event.
      // Only a user gesture changes the document session's selection.
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
  ]
  return () => {
    for (const unsubscribe of stop) unsubscribe()
  }
}
