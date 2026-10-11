/** What the Diagram brings to the canvas: its renderer, loaded while the worker prepares the case,
 *  and where the case places its blocks. It maps no samples, so time leaves it as it is. */

import type { Diagram } from '@latkit/diagram'
import type { Positions } from '@latkit/gpu'

import { bridge } from '../bridge.js'
import type { Host, Kind } from '../kind.js'
import { ofShown, type Snapshot, staticNeeds } from '../rows.js'

export function diagram(host: Host): Kind {
  let module: typeof import('./diagram.js') | undefined
  let styles: typeof import('./style.js') | undefined
  const loaded = Promise.all([import('./diagram.js'), import('./style.js')]).then(
    ([diagram, style]) => {
      module = diagram
      styles = style
    },
  )
  /** Where the case saves its diagram blocks, as last sent. */
  let presented: Record<string, Positions> = {}
  const config = (rows: Snapshot) =>
    styles!.diagramConfig(rows.data, host.state(), (presented = rows.presentation ?? presented))

  return {
    loaded,
    presentation: true,
    needs: (summary, bindings) => staticNeeds(summary, bindings, false),
    // It maps nothing, so the rows of the case on show are enough.
    current: (rows) => ofShown(rows, host.state()) && !host.state().stale,
    ready: () => true,
    arrange(rows) {
      if (!module || !styles) return false
      // A case with no directed signal components has nothing to draw here.
      const empty = !module.diagrammed(rows.data)
      host.element.toggleAttribute('data-empty', empty)
      if (empty) {
        host.drop()
        host.settle()
      }
      return !empty
    },
    mount(gpu, rows) {
      const view = module!.mountDiagram(
        gpu,
        host.canvas,
        config(rows),
        () => host.state(),
        host.select,
        host.open,
        bridge.report,
      )
      // A large diagram takes a while to lay out.
      host.waiting('Arranging the diagram…')
      return view
    },
    paint: (view, rows) => (view as Diagram).set(config(rows), { replace: true }),
    painted() {},
    presented() {},
    item: (view, element) => module!.diagramItem(view as Diagram, element),
    sync() {},
    act() {},
    retry() {},
    stats: () => ({}),
    dispose() {},
  }
}
