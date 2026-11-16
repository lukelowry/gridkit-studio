/** The maps a geographic case can lie on. Settings offers them and the Network draws them. */

export interface Basemap {
  readonly label: string
  /** Shown with the choice in Settings. */
  readonly description: string
  /** Vector tiles in OpenMapTiles' layers. Natural Earth is included, and Custom reads the Tiles
   *  URL setting. */
  readonly url?: string
  /** The credit shown under the map. */
  readonly attribution?: string
}

export const BASEMAPS = {
  naturalEarth: {
    label: 'Natural Earth',
    description: 'Included. Coasts, lakes, countries and states. Works offline.',
  },
  openFreeMap: {
    label: 'OpenFreeMap',
    description: 'OpenStreetMap streets from openfreemap.org, fetched as you move. No key.',
    url: 'https://tiles.openfreemap.org/planet',
    attribution: '© OpenStreetMap contributors · OpenFreeMap',
  },
  custom: {
    label: 'Custom',
    description: 'OpenMapTiles vector tiles from `#gridkitStudio.map.tilesUrl#`.',
  },
} as const satisfies Record<string, Basemap>

export const BASEMAP_IDS = Object.keys(BASEMAPS) as (keyof typeof BASEMAPS)[]
