import { expect, it, vi } from 'vitest'

vi.mock('../bridge.js', () => ({ bridge: { request: vi.fn() } }))

const { refresher, resultTiles, tileRequest } = await import('./results.js')

it("names each file of a field's tiles as latkit resolves it, and reads the name back", () => {
  const every = resultTiles('run 1', 'Bus', 'V/m', undefined)
  const one = resultTiles('run 1', 'Bus', 'V/m', 'A')
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
  // A number id stays a number.
  expect(tileRequest(at(resultTiles('r', 'Bus', 'Vm', 7), '3/12.latk'))).toMatchObject({
    id: 7,
    file: { level: 3, index: 12 },
  })
  expect(() => tileRequest(at(every, 'other.json'))).toThrow('Not a file of results')
  expect(() => tileRequest('https://tiles/frames.json')).toThrow('Not a file of results')
})

it('refreshes as a run grows, once more after a draw for all that came meanwhile', async () => {
  const refresh = vi.fn()
  let draw!: () => void
  const drawn = vi.fn(() => new Promise<void>((resolve) => (draw = resolve)))
  const grow = refresher({ refresh }, drawn)
  grow()
  grow()
  grow()
  expect(refresh).toHaveBeenCalledTimes(1)
  draw()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
  draw()
  await vi.waitFor(() => expect(drawn).toHaveBeenCalledTimes(2))
  // Without a view, nothing waits.
  const alone = vi.fn()
  const once = refresher({ refresh: alone }, () => undefined)
  once()
  await vi.waitFor(() => expect(alone).toHaveBeenCalledTimes(1))
  once()
  await vi.waitFor(() => expect(alone).toHaveBeenCalledTimes(2))
})
