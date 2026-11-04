import { type Placed, Shot, type View } from 'latkit'

import { bridge } from '../bridge.js'

/** Pixels per CSS pixel of an image: twice the page's, so it stays sharp in a document. */
export const SCALE = 2

/** The case's file name without `.case.json`, as an export names its file. */
export const caseStem = (name: string) =>
  name.replace(/(\.case)?\.json$/i, '').replace(/[\\/:*?"<>|]/g, '_')

/** A picture of exactly what `view`'s canvas shows. */
export const viewShot = (view: View) => Shot.of(view, { scale: SCALE, capture: 'now' })

/** A picture `size` CSS pixels large of `views`, each drawn into its region. */
export const picture = (size: readonly [number, number], views: readonly Placed[]) =>
  new Shot([Math.round(size[0] * SCALE), Math.round(size[1] * SCALE)], {
    scale: SCALE,
    capture: 'now',
    views,
  })

/** Draws `shot` and asks the user where beside the case at `uri` to save it as a PNG. */
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
