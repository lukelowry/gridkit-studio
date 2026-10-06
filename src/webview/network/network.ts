/** Mount the network renderer, find elements in it, and switch its projection. */

import type { Gpu } from '@latkit/gpu'
import { type Data, itemId } from '@latkit/model'
import {
  createNetwork,
  type Network,
  type NetworkConfig,
  type NetworkItem,
  type Projection,
} from '@latkit/network'

import type { Element, ViewState } from '../../shared/messages.js'
import { located } from '../../shared/positions.js'
import { defaults } from '../../shared/preferences.js'
import { elementType, networkOf } from '../../shared/schema.js'
import { itemOf, nativeMenu } from '../menu.js'

/** Whether the case places its vertices in longitude and latitude, so the globe can show it. */
export function isGeographic(source: Data): boolean {
  return networkOf(source.schema).geographic && located(source)
}

/** `preferred`, or flat where the globe cannot show the case. */
export function projectionOf(preferred: Projection, geographic: boolean): Projection {
  return preferred === 'globe' && !geographic ? 'flat' : preferred
}

/** The network on `canvas`, telling `select` of the element the user picks and `open` of the one
 *  they open. */
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
export function networkItem(network: Network, { id }: Element): NetworkItem | undefined {
  const { source, vertices, edges } = network.config
  const type = elementType(id)
  const kind = vertices[type] ? 'vertex' : edges?.[type] ? 'edge' : undefined
  if (!kind) return undefined
  const item = itemOf(source, id)
  return item && { kind, ...item }
}

/** Switch projection in place, ending any orbit; Tilt eases to the fit pitch to show heights. */
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
