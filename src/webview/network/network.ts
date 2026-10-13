/** Mount the network renderer, find elements in it, and switch its projection. */

import type { Gpu, ProjectedCamera } from '@latkit/gpu'
import { type Data, itemId } from '@latkit/model'
import { createNetwork, type Network } from '@latkit/network'

import type { Element, ViewState } from '../../shared/messages.js'
import { located } from '../../shared/positions.js'
import { defaults, type SettingsValues } from '../../shared/preferences.js'
import { elementType, networkOf } from '../../shared/schema.js'
import { itemOf, nativeMenu } from '../menu.js'

/** A projection the view offers. */
export type Projection = SettingsValues['network.camera.projection']

/** Whether the case places its vertices in longitude and latitude, so the globe can show it. */
export function isGeographic(source: Data): boolean {
  return networkOf(source.schema).geographic && located(source)
}

/** The camera's projection for `preferred`. A network on Earth lies flat as the Web Mercator map
 *  its tiles are drawn in, and only a network on Earth shows on the globe. */
export function projectionOf(
  preferred: Projection,
  geographic: boolean,
): ProjectedCamera.Projection {
  if (preferred === 'flat') return geographic ? 'mercator' : 'flat'
  return preferred === 'globe' && !geographic ? 'flat' : preferred
}

/** Whether `projection` lays the drawing flat, so the ground fills all the canvas. */
export const isFlat = (projection: ProjectedCamera.Projection): boolean =>
  projection === 'flat' || projection === 'mercator'

/** The projection the view offers that the camera's `projection` is. */
export const offeredAs = (projection: ProjectedCamera.Projection): Projection =>
  projection === 'mercator' ? 'flat' : projection

/** The network on `canvas`, telling `select` of the element the user picks and `open` of the one
 *  they open. */
export function mountNetwork(
  gpu: Gpu,
  canvas: HTMLCanvasElement,
  config: Omit<Network.Config, 'canvas'>,
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
export function networkItem(network: Network, { id }: Element): Network.Item | undefined {
  const { source, vertices, edges } = network.config
  const type = elementType(id)
  const kind = vertices[type] ? 'vertex' : edges?.[type] ? 'edge' : undefined
  if (!kind) return undefined
  const item = itemOf(source, id)
  return item && { kind, ...item }
}

/** Switch projection in place, ending any orbit; Tilt eases to the fit pitch to show heights. */
export function setProjection(network: Network, projection: Projection): void {
  const camera = projectionOf(projection, network.projections.mercator)
  if (!network.projections[camera]) return
  network.set({ camera: { orbit: false } })
  const fit = network.camera.fit ?? true
  network.set({ camera: { projection: camera, fit } })
  if (camera === 'tilt')
    network.set(
      { camera: { pitch: network.config.fitPitch ?? defaults['network.fitPitch'], fit } },
      { animate: true },
    )
}
