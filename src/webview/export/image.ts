import { type ImageFormat, type Placed, Shot, type View } from 'latkit'

import { caseStem } from '../../shared/format.js'
import { exportDefaults, type ExportSettings } from '../../shared/settings.js'
import { bridge } from '../bridge.js'

/** How an image is drawn and encoded, from the Export settings. */
export interface ImageOptions {
  readonly scale: number
  readonly format: ImageFormat
  readonly quality: number
  readonly transparent: boolean
}

export const imageOptions = (settings: ExportSettings = exportDefaults): ImageOptions => ({
  scale: settings['export.scale'],
  format: settings['export.imageFormat'],
  quality: settings['export.jpegQuality'],
  // JPEG has no alpha channel.
  transparent: settings['export.transparent'] && settings['export.imageFormat'] !== 'jpeg',
})

const EXTENSIONS: Record<ImageFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' }

/** A shot of exactly what `view`'s canvas shows. */
export const viewShot = (view: View, { scale, transparent }: ImageOptions) =>
  Shot.of(view, { scale, transparent, capture: 'now' })

/** A shot of `views`, each in its region, `size` in CSS pixels. */
export const picture = (
  size: readonly [number, number],
  views: readonly Placed[],
  { scale, transparent }: ImageOptions,
) =>
  new Shot([Math.round(size[0] * scale), Math.round(size[1] * scale)], {
    scale,
    transparent,
    capture: 'now',
    views,
  })

/** Encodes `shot` and asks the user where to save it, beside the case at `uri`. The file is named
 *  after the case `name` and `suffix`. */
export async function saveImage(
  shot: Shot,
  uri: string,
  name: string,
  suffix: string,
  { format, quality }: ImageOptions,
  signal: AbortSignal,
): Promise<string | null> {
  using image = await shot.image({ signal })
  const bytes = await image.encode(format, { ...(format === 'jpeg' && { quality }), signal })
  return bridge.request(
    'exportSave',
    { uri, name: `${caseStem(name)}-${suffix}.${EXTENSIONS[format]}`, bytes },
    signal,
  )
}
