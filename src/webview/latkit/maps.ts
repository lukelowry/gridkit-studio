import { Data, field, type Mark, Tiles, when, zoom } from 'latkit'

import type { SettingsReader } from '../../shared/settings.js'
import { asset } from './load.js'
import { type Palette, theme } from './theme.js'

/** A map drawn under the Network. Its datasets last as long as the page, so restyling it reads
 *  nothing again. */
export interface Background {
  readonly sources: ReadonlyArray<Data | Tiles>
  readonly marks: readonly Mark[]
  readonly attribution?: string
}

/** No map: a case that is not geographic, or the Map setting `none`. */
export const NO_MAP: Background = { sources: [], marks: [] }

const modeOf = (settings: SettingsReader, geographic: boolean) =>
  geographic ? settings.get('network.map.source') : 'none'

/** Everything `mapOf` depends on; the map is rebuilt only when this changes. */
export function mapKey(settings: SettingsReader, geographic: boolean): string {
  return JSON.stringify([
    modeOf(settings, geographic),
    settings.get('network.map.tilesUrl'),
    settings.get('network.map.attribution'),
    theme().palette,
  ])
}

export async function mapOf(
  settings: SettingsReader,
  geographic: boolean,
  signal: AbortSignal,
): Promise<Background> {
  const mode = modeOf(settings, geographic)
  const { palette } = theme()
  if (mode === 'borders') {
    signal.throwIfAborted()
    const data = await borderData(new URL(asset('latkit-assets')))
    signal.throwIfAborted()
    return {
      sources: data,
      marks: data.map((source, index): Mark => ({
        lines: [source.name, 'lines'],
        name: source.name,
        geometry: 'geometry',
        color: palette.text2,
        width: index === 0 ? 0.6 : 1,
        dash: index === 0,
        pick: false,
        select: false,
      })),
    }
  }
  if (mode === 'streets') {
    const { source, marks } = streetMaps(settings.get('network.map.tilesUrl'), palette)
    return { sources: [source], marks, attribution: settings.get('network.map.attribution') }
  }
  return NO_MAP
}

let borders: Promise<Data[]> | undefined

/** The bundled borders under `base`, provinces first. Read once per page; a failed read releases
 *  the borders that did load, and the next call reads them all again. */
export function borderData(base: URL): Promise<Data[]> {
  if (borders) return borders
  const reading = (async () => {
    const results = await Promise.allSettled(
      ['provinces', 'countries', 'coastline'].map((name) =>
        Data.read(new URL(`maps/${name}.geojson.gz`, base).href, { name: `map:${name}` }),
      ),
    )
    const failure = results.find((result) => result.status === 'rejected')
    if (failure) {
      for (const result of results) if (result.status === 'fulfilled') result.value.destroy()
      throw failure.reason
    }
    return results.map((result) => (result as PromiseFulfilledResult<Data>).value)
  })()
  borders = reading
  reading.catch(() => {
    if (borders === reading) borders = undefined
  })
  return reading
}

const streets = new Map<string, Tiles>()

/** OpenMapTiles layers under a case. The tiles have no land layer, so land is the earth's ground
 *  color and only water differs. Minor roads appear from zoom 12; borders only for countries and
 *  states, on land. */
function streetMaps(url: string, palette: Palette): { source: Tiles; marks: Mark[] } {
  let source = streets.get(url)
  if (!source) streets.set(url, (source = new Tiles('map:streets', url)))
  const kind = field('class')
  const major = kind
    .is('motorway')
    .or(kind.is('trunk'))
    .or(kind.is('primary'))
    .or(kind.is('secondary'))
  const minor = kind.is('tertiary').or(kind.is('minor')).or(kind.is('service'))
  const ground = { pick: false, select: false } as const
  return {
    source,
    marks: [
      { areas: [source.name, 'water'], color: palette.surface2, ...ground },
      {
        areas: [source.name, 'building'],
        color: palette.border,
        visible: zoom().gt(15),
        ...ground,
      },
      {
        lines: [source.name, 'transportation'],
        color: palette.text2,
        width: when(major).then(1.2).otherwise(0.6),
        visible: major.or(minor.and(zoom().gt(12))),
        ...ground,
      },
      {
        lines: [source.name, 'boundary'],
        color: palette.text2,
        visible: field('admin_level').lt(5).and(field('maritime').fallback(0).lt(1)),
        dash: field('admin_level').gt(2),
        ...ground,
      },
    ],
  }
}
