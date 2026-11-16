import { createRequire } from 'node:module'

import type { Mark } from 'latkit'
import { beforeAll, expect, it } from 'vitest'

import { reader } from '../../shared/settings.js'
import { loadNative } from '../../workers/native.js'
import { mapKey, mapOf, NO_MAP } from './maps.js'

beforeAll(() => loadNative(createRequire(import.meta.url).resolve('latkit/wasm')))

const COLORS = { land: '#1f1f1f', water: '#14354f', line: '#666666', faint: '#303030' }

const tableOf = (mark: Mark) => ('areas' in mark ? mark.areas : 'lines' in mark ? mark.lines : null)

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

it('draws tiles as OpenMapTiles layers, water first, in the colors given', async () => {
  const map = await mapOf(
    reader({
      'map.basemap': 'custom',
      'map.tilesUrl': 'https://tiles.test/planet',
      'map.attribution': '© test',
    }),
    true,
  )
  expect(map.attribution).toBe('© test')
  const marks = map.marks(COLORS)
  expect(marks.map(tableOf)).toEqual(
    ['water', 'building', 'transportation', 'boundary'].map((layer) => [
      map.sources[0]!.name,
      layer,
    ]),
  )
  expect(marks[0]).toMatchObject({ color: COLORS.water, pick: false, select: false })
  expect(map.marks({ ...COLORS, water: '#0000ff' })[0]).toMatchObject({ color: '#0000ff' })
  // One dataset per URL for the page's life, whatever chose it.
  const again = await mapOf(
    reader({ 'map.basemap': 'custom', 'map.tilesUrl': 'https://tiles.test/planet' }),
    true,
  )
  expect(again.sources[0]).toBe(map.sources[0])
})
