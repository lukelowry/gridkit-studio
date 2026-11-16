import { type Mark, Tiles, type TilesDescription } from 'latkit'
import { expect, it } from 'vitest'

import { reader } from '../../shared/settings.js'
import { mapKey, mapOf, NO_MAP, tileMap } from './maps.js'

const COLORS = { land: '#1f1f1f', water: '#14354f', line: '#666666', faint: '#303030' }

const tableOf = (mark: Mark) => ('areas' in mark ? mark.areas : 'lines' in mark ? mark.lines : null)

/** What a source says of itself: the `layers` it lists, and no credit. */
const said = (...layers: string[]): TilesDescription => ({
  attribution: null,
  zooms: [0, 14],
  bounds: [-180, -85, 180, 85],
  layers: layers.map((name) => ({ name, fields: [] })),
})

it('reads a map again only for a new source, never for its colors', async () => {
  // A case that is not geographic, None, and Custom without tiles have no map.
  expect(await mapOf(reader(), false)).toBe(NO_MAP)
  expect(await mapOf(reader({ 'map.basemap': 'none' }), true)).toBe(NO_MAP)
  expect(await mapOf(reader({ 'map.basemap': 'custom' }), true)).toBe(NO_MAP)
  expect(mapKey(reader({ 'map.waterColor': '#0000ff', 'map.landColor': '#ffffff' }), true)).toBe(
    mapKey(reader(), true),
  )
  const custom = { 'map.basemap': 'custom', 'map.tilesUrl': ' https://tiles.test/planet ' } as const
  const credited = { ...custom, 'map.attribution': '© test' }
  expect(mapKey(reader(custom), true)).not.toBe(mapKey(reader(credited), true))
  expect(mapKey(reader(custom), true)).not.toBe(
    mapKey(reader({ 'map.basemap': 'openFreeMap' }), true),
  )
})

it('draws tiles as the OpenMapTiles layers their source lists, water first, in the colors given', () => {
  const tiles = new Tiles('map:tiles', 'https://tiles.test/planet')
  const tablesOf = (description: TilesDescription) =>
    tileMap(tiles, description)
      .marks(COLORS)
      .map(tableOf)
      .map((table) => (table as [string, string])[1])
  // A URL template lists no layers, so every layer is drawn.
  expect(tablesOf(said())).toEqual(['water', 'building', 'transportation', 'boundary'])
  // A source that lists its layers is drawn only where it has them.
  expect(tablesOf(said('boundary', 'place', 'water'))).toEqual(['water', 'boundary'])
  expect(tablesOf(said('contours'))).toEqual([])
  const map = tileMap(tiles, said())
  expect(map.sources).toEqual([tiles])
  expect(map.marks(COLORS)[0]).toMatchObject({
    areas: [tiles.name, 'water'],
    color: COLORS.water,
    pick: false,
    select: false,
  })
  expect(map.marks({ ...COLORS, water: '#0000ff' })[0]).toMatchObject({ color: '#0000ff' })
})

it('credits tiles as the Attribution setting says, and without one only as their source asks', () => {
  const tiles = new Tiles('map:tiles', 'https://tiles.test/planet')
  expect(tileMap(tiles, said(), '© test').attribution).toBe('© test')
  expect(tileMap(tiles, { ...said(), attribution: '© source' }, '© test').attribution).toBe(
    '© test',
  )
  // A source that asks for no credit gets none.
  expect(tileMap(tiles, said())).not.toHaveProperty('attribution')
})
