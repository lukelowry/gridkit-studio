import { type Placed, Shot, type View } from 'latkit'

import { caseStem } from '../../shared/format.js'
import { bridge } from '../bridge.js'

/** Image pixels per CSS pixel: 2 keeps an image sharp in a document. */
const SCALE = 2

export const viewShot = (view: View) => Shot.of(view, { scale: SCALE, capture: 'now' })

/** A shot of `views`, each in its region, `size` in CSS pixels. */
export const picture = (size: readonly [number, number], views: readonly Placed[]) =>
  new Shot([Math.round(size[0] * SCALE), Math.round(size[1] * SCALE)], {
    scale: SCALE,
    capture: 'now',
    views,
  })

/** Encodes `shot` as a PNG and asks the user where to save it, next to the case at `uri`. */
export async function saveImage(
  shot: Shot,
  uri: string,
  name: string,
  view: 'network' | 'monitor',
  signal: AbortSignal,
): Promise<void> {
  using image = await shot.image({ signal })
  const bytes = await image.encode('png', { signal })
  await bridge.request('exportSave', { uri, name: `${caseStem(name)}-${view}.png`, bytes }, signal)
}
