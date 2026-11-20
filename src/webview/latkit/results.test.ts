import { expect, it, vi } from 'vitest'

vi.mock('../bridge.js', () => ({ bridge: { request: vi.fn() } }))

const { superseded } = await import('../../shared/errors.js')
const { bridge } = await import('../bridge.js')
const { refreshResults, ResultTiles, tile, tileRequest } = await import('./results.js')

it("names each file of a field's tiles as latkit resolves it, and reads the name back", () => {
  const run = new ResultTiles('run 1')
  const every = run.field('Bus', 'V/m')
  const one = run.field('Bus', 'V/m', 'A')
  // Each is its own dataset, named by its URL.
  expect(every.name).toBe(every.url)
  expect(one.url).not.toBe(every.url)
  const at = (tiles: { url: string }, file: string) => tiles.url.replace(/frames\.json$/, file)
  expect(tileRequest(every.url)).toEqual({
    results: 'run 1',
    table: 'Bus',
    field: 'V/m',
    file: 'frames.json',
  })
  expect(tileRequest(at(one, 'base.latk'))).toEqual({
    results: 'run 1',
    table: 'Bus',
    field: 'V/m',
    id: 'A',
    file: 'base.latk',
  })
  expect(tileRequest(at(run.field('Bus', 'Vm', 7), '3/12.latk'))).toMatchObject({
    id: 7,
    file: { level: 3, index: 12 },
  })
  expect(() => tileRequest(at(every, 'other.json'))).toThrow('Not a file of results')
  expect(() => tileRequest('https://tiles/frames.json')).toThrow('Not a file of results')
})

it('shares tiles within one open result, including when an export opens another', () => {
  const run = new ResultTiles('run 1')
  const first = run.field('Bus', 'Vm')
  expect(run.field('Bus', 'Vm', 7)).not.toBe(first)
  const exportRun = new ResultTiles('leased')
  expect(exportRun.field('Bus', 'Vm')).not.toBe(first)
  expect(run.field('Bus', 'Vm')).toBe(first)
})

it('cancels a superseded fetch without evicting the new run’s tiles', async () => {
  const request = vi.mocked(bridge.request)
  const first = new ResultTiles('run 9').field('Bus', 'Vm')
  request.mockRejectedValueOnce(superseded())
  const read = tile(first.url)
  const run = new ResultTiles('run 10')
  const next = run.field('Bus', 'Vm')
  await expect(read).rejects.toMatchObject({ name: 'AbortError' })
  expect(run.field('Bus', 'Vm')).toBe(next)
  // Any other failure is the tiles' own, and a file that arrives is passed on.
  request.mockRejectedValueOnce(new Error('The disk is gone.'))
  await expect(tile(first.url)).rejects.toThrow('The disk is gone.')
  request.mockResolvedValueOnce(Uint8Array.of(1, 2))
  await expect(tile(first.url)).resolves.toEqual(Uint8Array.of(1, 2))
  await expect(tile('https://tiles/frames.json')).rejects.toThrow('Not a file of results')
})

it('refreshes a shared source once per increase in recorded frames', () => {
  const tiles = new ResultTiles('live').field('Bus', 'Vm')
  const refresh = vi.spyOn(tiles, 'refresh')
  refreshResults(tiles, 1)
  expect(refresh).not.toHaveBeenCalled()
  for (const frames of [2, 2, 1, 3, 3]) refreshResults(tiles, frames)
  expect(refresh).toHaveBeenCalledTimes(2)
})
