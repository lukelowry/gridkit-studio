import { Data, field, type Mark, Tiles, when, zoom } from 'latkit'

import type { SettingsReader } from '../../shared/settings.js'
import { asset } from './load.js'
import { type Palette, theme } from './theme.js'

/** A map under the Network: the datasets it draws, its marks, and whose map it is. */
export interface Background {
  readonly sources: ReadonlyArray<Data | Tiles>
  readonly marks: readonly Mark[]
  readonly attribution?: string
  destroy?(): void
}

/** No map: a case off the earth, or the Map setting's `none`. */
export const NO_MAP: Background = { sources: [], marks: [] }

const modeOf = (settings: SettingsReader, geographic: boolean) =>
  geographic ? settings.get('network.map.source') : 'none'

/** What the map `mapOf` makes depends on: a page makes it again only once this changes. */
export function mapKey(settings: SettingsReader, geographic: boolean): string {
  return JSON.stringify([
    modeOf(settings, geographic),
    settings.get('network.map.tilesUrl'),
    settings.get('network.map.attribution'),
    theme().palette,
  ])
}

/** The map the settings choose under a case, as the Network and every export draw it: none for a
 *  case off the earth. */
export async function mapOf(
  settings: SettingsReader,
  geographic: boolean,
  signal: AbortSignal,
): Promise<Background> {
  const mode = modeOf(settings, geographic)
  const { palette } = theme()
  if (mode === 'borders') {
    const { data, marks } = await borderMaps(new URL(asset('latkit-assets')), palette, signal)
    return { sources: data, marks, destroy: () => data.forEach((source) => source.destroy()) }
  }
  if (mode === 'streets') {
    const { source, marks } = streetMaps(settings.get('network.map.tilesUrl'), palette)
    return { sources: [source], marks, attribution: settings.get('network.map.attribution') }
  }
  return NO_MAP
}

export async function borderMaps(
  base: URL,
  palette: Palette,
  signal: AbortSignal,
): Promise<{ data: Data[]; marks: Mark[] }> {
  const results = await Promise.allSettled(
    ['provinces', 'countries', 'coastline'].map((name) =>
      Data.read(new URL(`maps/${name}.geojson.gz`, base).href, { name: `map:${name}`, signal }),
    ),
  )
  const failure = results.find((result) => result.status === 'rejected')
  if (failure || signal.aborted) {
    for (const result of results) if (result.status === 'fulfilled') result.value.destroy()
    if (failure) throw failure.reason
    signal.throwIfAborted()
  }
  const data = results.map((result) => (result as PromiseFulfilledResult<Data>).value)
  return {
    data,
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

/** The street map's tiles, one per URL for the page's life: a theme or setting that restyles the
 *  map fetches nothing again. */
const streets = new Map<string, Tiles>()

/** OpenMapTiles' layers as the ground under a case. The tiles have no land layer: the land is the
 *  earth's ground, so water is what differs from it. Roads show by class, the smaller ones once a
 *  town's streets can be told apart, and borders only of countries and states on land. */
export function streetMaps(url: string, palette: Palette): { source: Tiles; marks: Mark[] } {
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
