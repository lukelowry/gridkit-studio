/** Create the case's network renderer, map element identities, and turn its camera. */

import type { Positions } from '@latkit/diagram'
import type { Gpu } from '@latkit/gpu'
import { type Data, itemId, selectRows } from '@latkit/model'
import {
  createNetwork,
  type Network,
  type NetworkConfig,
  type NetworkItem,
  type Projection,
} from '@latkit/network'

import type { Element, ViewState } from '../../shared/messages.js'
import { defaults } from '../../shared/preferences.js'
import { networkOf } from '../../shared/schema.js'
import { nativeMenu } from '../menu.js'

/** Whether `source` stands on Earth: its vertices are placed in longitude and latitude, by the case
 *  rather than by a layout. */
export function isGeographic(
  source: Data,
  places: Readonly<Record<string, Positions>> = {},
): boolean {
  return networkOf(source.schema).geographic && Object.keys(places).length === 0
}

/** The projection a network of the case first shows in: the preferred one, but flat where the globe
 *  cannot show it. */
export function projectionOf(preferred: Projection, geographic: boolean): Projection {
  return preferred === 'globe' && !geographic ? 'flat' : preferred
}

/** The case's network on `canvas` as `config` draws it. `select` hears of the element the reader
 *  picks, and `open` of the one they open. */
export function mountNetwork(
  gpu: Gpu,
  canvas: HTMLCanvasElement,
  config: Omit<NetworkConfig, 'canvas'>,
  state: () => ViewState,
  select: (element: Element | null) => void,
  open: (element: Element) => void,
): Network {
  const network = createNetwork(gpu, { ...config, canvas })
  network.on('select', (items) => {
    select(items[0] ? { id: itemId(items[0]) } : null)
  })
  network.on('open', (item) => open({ id: itemId(item) }))
  network.on('contextmenu', (event) =>
    nativeMenu(
      canvas,
      event.point,
      event.items.map((item) => ({ id: itemId(item) })),
      state(),
      'network',
    ),
  )
  return network
}

/** The network item `element` is; undefined when the network does not draw its type. */
export function networkItem(network: Network, element: Element): NetworkItem | undefined {
  const source = network.config.source
  const type = element.id.split('/')[0]!
  const table = source.tables[type]
  if (!table) return undefined
  const rows = selectRows(table, { kind: 'ids', ids: [element.id] })
  const row = rows.kind === 'range' ? (rows.count ? rows.offset : undefined) : rows.values[0]
  if (row === undefined) return undefined
  const kind = network.config.vertices[type]
    ? 'vertex'
    : network.config.edges?.[type]
      ? 'edge'
      : undefined
  return kind ? { kind, source, index: table.index, row } : undefined
}

/** Switch projection where the camera looks, Tilt easing down to its pitch to show the heights;
 *  switching ends a rotation. */
export function setProjection(network: Network, projection: Projection): void {
  if (!network.projections[projection]) return
  network.set({ camera: { orbit: false } })
  const fit = network.camera.fit ?? true
  network.set({ camera: { projection, fit } })
  if (projection === 'tilt')
    network.set(
      { camera: { pitch: network.config.fitPitch ?? defaults['network.fitPitch'], fit } },
      { animate: true },
    )
}
