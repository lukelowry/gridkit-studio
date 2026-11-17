import {
  Data,
  field,
  type Mark,
  type TableInput,
  Tiles,
  type TilesDescription,
  when,
  zoom,
} from 'latkit'

import { type Basemap, BASEMAPS } from '../../shared/basemaps.js'
import type { SettingsReader } from '../../shared/settings.js'
import { asset, loadLatkit } from './load.js'
import type { MapColors } from './theme.js'

/** A map under the Network: its datasets, read once per page, and its marks in any colors, so a
 *  new theme or an export in another one reads nothing again. */
export interface Background {
  readonly sources: ReadonlyArray<Data | Tiles>
  readonly marks: (colors: MapColors) => Mark[]
  readonly attribution?: string
}

/** No map: a case that is not geographic, or the Basemap setting None. */
export const NO_MAP: Background = { sources: [], marks: () => [] }

/** The map the settings choose for a case: tiles at a URL, the included map without one, or null
 *  for none. Custom without a URL is none, and only Custom takes the Attribution setting. */
function chosen(
  settings: SettingsReader,
  geographic: boolean,
): (Pick<Basemap, 'url'> & { readonly attribution?: string }) | null {
  const id = geographic ? settings.get('map.basemap') : 'none'
  if (id === 'none') return null
  if (id === 'custom') {
    const url = settings.get('map.tilesUrl').trim()
    const attribution = settings.get('map.attribution').trim()
    return url ? { url, ...(attribution && { attribution }) } : null
  }
  const { url }: Basemap = BASEMAPS[id]
  return { url }
}

/** What `mapOf` reads; the map is read again only when this changes. */
export const mapKey = (settings: SettingsReader, geographic: boolean): string =>
  JSON.stringify(chosen(settings, geographic))

/** The map the settings choose. Tiles are asked what they hold first, so a map that cannot be
 *  reached fails here; `signal` ends that wait. */
export async function mapOf(
  settings: SettingsReader,
  geographic: boolean,
  signal?: AbortSignal,
): Promise<Background> {
  const map = chosen(settings, geographic)
  if (!map) return NO_MAP
  // latkit loads from the page's assets before a read below asks it to load from its own.
  await loadLatkit()
  if (!map.url) {
    const data = await naturalEarth()
    // GeoJSON tables are named by geometry: the polygons are water and the lines boundaries.
    return {
      sources: [data],
      marks: style({ water: [data.name, 'polygons'], boundary: [data.name, 'lines'] }),
    }
  }
  const tiles = tilesAt(map.url)
  return tileMap(tiles, await tiles.describe(signal ? { signal } : {}), map.attribution)
}

/** `tiles` as a map, given what their source `said` of itself. It draws the OpenMapTiles layers
 *  the source lists, or all of them when it lists none, as a URL template does. It is credited
 *  with `attribution`, or without one as the source asks. */
export function tileMap(tiles: Tiles, said: TilesDescription, attribution?: string): Background {
  const listed = new Set(said.layers.map((layer) => layer.name))
  const layers = LAYERS.filter((layer) => !listed.size || listed.has(layer))
  const credit = attribution ?? textOf(said.attribution)
  return {
    sources: [tiles],
    marks: style(Object.fromEntries(layers.map((layer) => [layer, [tiles.name, layer]]))),
    ...(credit && { attribution: credit }),
  }
}

/** A source's credit as text. A source may write it as HTML, which the scene's title cannot
 *  show. */
function textOf(credit: string | null): string {
  if (!credit) return ''
  const text = new DOMParser().parseFromString(credit, 'text/html').body.textContent
  return text.replace(/\s+/g, ' ').trim()
}

let included: Promise<Data> | undefined

/** The included Natural Earth map, read once per page. A failed read is tried again next time. */
function naturalEarth(): Promise<Data> {
  if (included) return included
  const url = new URL('maps/natural-earth.geojson.gz', asset('latkit-assets')).href
  const reading = (included = Data.read(url, { name: 'map:natural-earth' }))
  reading.catch(() => {
    if (included === reading) included = undefined
  })
  return reading
}

const tiles = new Map<string, Tiles>()

/** One `Tiles` per URL for the page's life. latkit keeps what it fetched while a `Tiles` lives, so
 *  a Network that was hidden draws its map again without fetching it. */
function tilesAt(url: string): Tiles {
  let found = tiles.get(url)
  if (!found) tiles.set(url, (found = new Tiles('map:tiles', url)))
  return found
}

/** The OpenMapTiles layers a map draws. */
const LAYERS = ['water', 'building', 'transportation', 'boundary'] as const

/** The tables holding a map's layers. */
type Layers = Partial<Record<(typeof LAYERS)[number], TableInput>>

/** OpenMapTiles' layers in `colors`, for the layers in `tables`. The included Natural Earth map
 *  names its fields as OpenMapTiles does, so this one style draws every map. Water lies over the
 *  land's ground, so the coast is where they meet. Minor roads show past zoom 12 and buildings
 *  past zoom 15. */
function style(tables: Layers): Background['marks'] {
  return (colors) => {
    const kind = field('class')
    const major = kind
      .is('motorway')
      .or(kind.is('trunk'))
      .or(kind.is('primary'))
      .or(kind.is('secondary'))
    const minor = kind.is('tertiary').or(kind.is('minor')).or(kind.is('service'))
    const level = field('admin_level')
    const ground = { pick: false, select: false } as const
    const marks: Mark[] = []
    if (tables.water) marks.push({ areas: tables.water, color: colors.water, ...ground })
    if (tables.building)
      marks.push({
        areas: tables.building,
        color: colors.faint,
        visible: zoom().gt(15),
        ...ground,
      })
    if (tables.transportation)
      marks.push({
        lines: tables.transportation,
        color: colors.line,
        width: when(major).then(1.2).otherwise(0.6),
        visible: major.or(minor.and(zoom().gt(12))),
        ...ground,
      })
    // Countries solid and states dashed, on land only.
    if (tables.boundary)
      marks.push({
        lines: tables.boundary,
        color: colors.line,
        dash: level.gt(2),
        visible: level.lt(5).and(field('maritime').fallback(0).lt(1)),
        ...ground,
      })
    return marks
  }
}
