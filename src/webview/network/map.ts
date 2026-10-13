/** What lies on the ground under a network on Earth: Natural Earth's coasts and borders, shipped
 *  with Studio so the default map draws offline, or OpenStreetMap as vector tiles. Each source loads
 *  once a page, and every geography on it borrows what loaded. The Network imports this module
 *  only for a case on Earth, once it is on screen. */

import { createGeography, type Geography, geojson, type Tiles, tiles } from '@latkit/geography'
import type { Gpu, RGBA } from '@latkit/gpu'
import type { Data } from '@latkit/model'

import type { SettingsReader } from '../../shared/preferences.js'
import { color, faded, mix, type Palette } from '../theme.js'

/** What a map loaded: Natural Earth's lines, or tiles and whom they credit. */
export type Loaded =
  | { readonly kind: 'borders'; readonly lines: readonly Data[] }
  | { readonly kind: 'openstreetmap'; readonly tiles: Tiles; readonly attribution: string }

/** Natural Earth v5.1.2 1:10m, public domain: a type and its file each, coasts last so they draw
 *  over the borders that meet them. The build copies assets/maps beside the webview's scripts. */
const BORDERS = [
  ['Province', 'provinces'],
  ['Country', 'countries'],
  ['Coast', 'coastline'],
] as const
/** Whom OpenMapTiles' layers credit where the tiles name no one. */
const OPENSTREETMAP = '© OpenMapTiles © OpenStreetMap contributors'
/** Borders over the theme's text color, and provinces, finer and dashed, relative to them. */
const LINE_ALPHA = 0.5
const PROVINCE = { width: 0.75, alpha: 0.6 }
/** Hues that water and green land lean toward from the ground. */
const WATER: RGBA = [0.25, 0.5, 0.85, 1]
const GREEN: RGBA = [0.3, 0.65, 0.35, 1]

let borders: Promise<readonly Data[]> | undefined
const opened = new Map<string, Tiles>()

/** Which map `s` chooses: its source, and where tiles come from. */
export function mapKey(s: SettingsReader): string {
  const source = s.get('network.map.source')
  return source === 'openstreetmap' ? `${source} ${s.get('network.map.tilesUrl')}` : source
}

/** The map `s` chooses, loaded on first call; null for none. A failed load is tried again on the
 *  next call. */
export async function loadMap(s: SettingsReader): Promise<Loaded | null> {
  const source = s.get('network.map.source')
  if (source === 'none') return null
  if (source === 'borders') {
    const script = document.querySelector<HTMLScriptElement>('script[type=module]')!.src
    // Each file's bytes move from its fetch to the worker that unzips and parses them, uncopied.
    borders ??= Promise.all(
      BORDERS.map(([type, file]) =>
        geojson(new URL(`maps/${file}.geojson.gz`, script), { type, source: `studio:${file}` }),
      ),
    ).catch((error: unknown) => {
      borders = undefined
      throw error
    })
    return { kind: 'borders', lines: await borders }
  }
  const url = s.get('network.map.tilesUrl')
  let found = opened.get(url)
  if (!found) opened.set(url, (found = tiles(url, { persist: true })))
  try {
    // Opening reads the tiles' header, so a URL that serves none fails here, once.
    const { attribution } = await found.info
    return {
      kind: 'openstreetmap',
      tiles: found,
      attribution: credit(attribution) ?? OPENSTREETMAP,
    }
  } catch (error) {
    opened.delete(url)
    throw error
  }
}

/** The map a network draws beneath it, which tells `report` of its failures, when given: it takes
 *  no input, so the network answers every gesture. */
export function mountEarth(
  gpu: Gpu,
  config: Geography.Config,
  report?: (reason: unknown) => void,
): Geography {
  const earth = createGeography(gpu, config)
  if (report) earth.on('error', report)
  return earth
}

/** A credit's text; TileJSON writes it as HTML, which the page never inserts as such. */
function credit(html: string | undefined): string | undefined {
  if (!html) return undefined
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim()
  return text || undefined
}

/** The geography under a network on Earth: the ground, lit and lined as the settings say, and what
 *  `loaded` draws on it, named in the network's text. It takes no input: the network answers the
 *  pointer everywhere. */
export function mapConfig(
  s: SettingsReader,
  palette: Palette,
  font: string | null,
  loaded: Loaded | null,
  flat: boolean,
): Geography.Config {
  // Laid flat, the ground is all the canvas shows behind the network, so it is the network's own
  // background, as before the map joins; tilted or round, the Earth stands apart from beyond it.
  const ground = color(
    s.get('network.map.groundColor'),
    flat ? color(s.get('network.background'), palette.editor) : palette.surface2,
  )
  const line = color(s.get('network.map.lineColor'), faded(palette.text2, LINE_ALPHA))
  const widthPx = s.get('network.map.lineWidthPx')
  const family = s.get('network.font') || font
  return {
    input: 'none',
    ...(family && { font: { family } }),
    fontSizePx: s.get('network.fontSizePx'),
    labelHaloPx: s.get('network.labelHaloPx'),
    textColor: color(s.get('network.textColor'), palette.text2),
    surfaceColor: ground,
    grid: s.get('network.grid'),
    gridColor: color(s.get('network.gridColor'), palette.border),
    earthAxis: s.get('network.map.earthAxis'),
    daylight: s.get('network.map.daylight') ? 'now' : false,
    nightFloor: s.get('network.map.nightFloor'),
    terminatorWidth: s.get('network.map.terminatorWidth'),
    lineColor: line,
    lineWidthPx: widthPx,
    ...(loaded?.kind === 'borders' && bordersOn(loaded.lines, line, widthPx)),
    ...(loaded?.kind === 'openstreetmap' && streetsOn(loaded.tiles, ground, line, palette)),
  }
}

/** Natural Earth's lines: provinces finer and dashed beneath country borders and coasts. */
function bordersOn(lines: readonly Data[], line: RGBA, widthPx: number): Geography.Config {
  return {
    lines: Object.fromEntries(
      BORDERS.map(([type], i) => [
        type,
        type === 'Province'
          ? {
              source: lines[i]!,
              color: faded(line, PROVINCE.alpha),
              widthPx: widthPx * PROVINCE.width,
              dash: true,
            }
          : { source: lines[i]! },
      ]),
    ),
  }
}

/** OpenMapTiles' layers, a record type each, in colors drawn from the ground and the theme, with
 *  the names of parks and roads. Tiles decode only the fields records read. */
function streetsOn(source: Tiles, ground: RGBA, line: RGBA, palette: Palette): Geography.Config {
  const water = mix(ground, WATER, 0.3)
  return {
    source,
    areas: {
      landcover: { color: mix(ground, GREEN, 0.06) },
      park: { color: mix(ground, GREEN, 0.14), labels: 'name' },
      water: { color: water },
      building: { color: mix(ground, palette.text2, 0.12) },
    },
    lines: {
      waterway: { color: water, widthPx: 0.8 },
      transportation: { color: faded(palette.text2, 0.35), widthPx: 0.7 },
      boundary: { color: line, dash: true },
      // Names alone, along the roads `transportation` draws.
      transportation_name: { visible: false, labels: 'name' },
    },
  }
}
