import type { Tiles } from '@latkit/geography'
import type { Data } from '@latkit/model'
import { describe, expect, it } from 'vitest'

import { reader } from '../../shared/preferences.js'
import type { Palette } from '../theme.js'
import { mapConfig, mapKey } from './map.js'

const palette = new Proxy({}, { get: () => [0.2, 0.2, 0.2, 1] }) as Palette
const lines = ['provinces', 'countries', 'coastline'].map((name) => ({ name }) as unknown as Data)

describe('the map under a network on Earth', () => {
  it('keeps the ground with nothing on it while no map has loaded', () => {
    const config = mapConfig(reader(), palette, null, null)
    expect(config).toMatchObject({ input: 'none', surfaceColor: palette.surface2 })
    expect(config).not.toHaveProperty('lines')
    expect(config).not.toHaveProperty('source')
  })
  it('draws provinces finer and dashed, beneath country borders and coasts', () => {
    const s = reader({ 'network.map.lineWidthPx': 2 })
    const config = mapConfig(s, palette, null, { kind: 'borders', lines })
    expect(Object.keys(config.lines!)).toEqual(['Province', 'Country', 'Coast'])
    expect(config.lines!.Province).toMatchObject({ source: lines[0], dash: true })
    expect(config.lines!.Province!.widthPx).toBeLessThan(2)
    expect(config.lines!.Coast).toEqual({ source: lines[2] })
  })
  it('draws OpenStreetMap from its tiles, each layer by name', () => {
    const tiles = {} as Tiles
    const config = mapConfig(reader(), palette, null, {
      kind: 'openstreetmap',
      tiles,
      attribution: 'credit',
    })
    expect(config.source).toBe(tiles)
    expect(Object.keys(config.areas!)).toContain('water')
    expect(config.lines!.boundary).toMatchObject({ dash: true })
    // Roads are named by a record that draws nothing else.
    expect(config.lines!.transportation_name).toEqual({ visible: false, labels: 'name' })
  })
  it('tells maps apart by source, and tiles by where they come from', () => {
    const tiles = (url: string) =>
      reader({ 'network.map.source': 'openstreetmap', 'network.map.tilesUrl': url })
    expect(mapKey(reader())).toBe('borders')
    expect(mapKey(tiles('https://a/planet'))).not.toBe(mapKey(tiles('https://b/planet')))
  })
})
