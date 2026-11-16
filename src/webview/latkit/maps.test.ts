import { createRequire } from 'node:module'

import { Data } from 'latkit'
import { beforeAll, expect, it, vi } from 'vitest'

import { loadNative } from '../../workers/native.js'
import { borderData } from './maps.js'

beforeAll(() => loadNative(createRequire(import.meta.url).resolve('latkit/wasm')))

it('releases the borders that loaded when one fails, and reads them all again on the next call', async () => {
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
    await expect(borderData(new URL('https://bundled/'))).rejects.toThrow('Missing map')
    expect(destroyA).toHaveBeenCalledOnce()
    expect(destroyB).toHaveBeenCalledOnce()
    expect(String(read.mock.calls[0]![0])).toBe('https://bundled/maps/provinces.geojson.gz')
    // Read again after the failure and cached once it succeeds.
    read.mockImplementation(async (_source, options) => new Data(options!.name!))
    const kept = await borderData(new URL('https://bundled/'))
    expect(kept.map((data) => data.name)).toEqual([
      'map:provinces',
      'map:countries',
      'map:coastline',
    ])
    expect(await borderData(new URL('https://bundled/'))).toBe(kept)
    expect(read).toHaveBeenCalledTimes(6)
  } finally {
    read.mockRestore()
  }
})
