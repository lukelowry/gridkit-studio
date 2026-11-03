import { createRequire } from 'node:module'

import { Data } from 'latkit'
import { beforeAll, expect, it, vi } from 'vitest'

import { loadNative } from '../workers/native.js'
import { borderMaps, streetMaps } from './maps.js'
import type { Palette } from './theme.js'
beforeAll(() => loadNative(createRequire(import.meta.url).resolve('latkit/wasm')))
const palette = { text2: '#aaaaaa', background: '#000000', surface2: '#111111' } as Palette
it('cleans all successful map loads when one bundled border fails', async () => {
  const a = new Data('map:a')
  const b = new Data('map:b')
  const destroyA = vi.spyOn(a, 'destroy')
  const destroyB = vi.spyOn(b, 'destroy')
  const read = vi
    .spyOn(Data, 'read')
    .mockResolvedValueOnce(a)
    .mockRejectedValueOnce(new Error('Missing map'))
    .mockResolvedValueOnce(b)
  try {
    await expect(
      borderMaps(new URL('https://bundled/'), palette, AbortSignal.any([])),
    ).rejects.toThrow('Missing map')
    expect(destroyA).toHaveBeenCalledOnce()
    expect(destroyB).toHaveBeenCalledOnce()
    expect(String(read.mock.calls[0]![0])).toBe('https://bundled/maps/provinces.geojson.gz')
  } finally {
    read.mockRestore()
  }
})
it('makes optional street-map marks inert to selection and picking', () => {
  const { source, marks } = streetMaps('https://maps.example/{z}/{x}/{y}.pbf', palette)
  expect(source.name).toBe('map:streets')
  expect(marks.every((mark) => mark.pick === false && mark.select === false)).toBe(true)
})
