import { expect, it, vi } from 'vitest'

vi.mock('../bridge.js', () => ({ bridge: { request: vi.fn() } }))

const { superseded } = await import('../../shared/errors.js')
const { bridge } = await import('../bridge.js')
const { refresher, resultTiles, tile, tileRequest } = await import('./results.js')

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
  expect(tileRequest(at(resultTiles('r', 'Bus', 'Vm', 7), '3/12.latk'))).toMatchObject({
    id: 7,
    file: { level: 3, index: 12 },
  })
  expect(() => tileRequest(at(every, 'other.json'))).toThrow('Not a file of results')
  expect(() => tileRequest('https://tiles/frames.json')).toThrow('Not a file of results')
})

it("draws every plot of a field from the same tiles, and lets go of other results' tiles", () => {
  const first = resultTiles('run 1', 'Bus', 'Vm')
  // latkit shares what it fetched only among the views of one Tiles.
  expect(resultTiles('run 1', 'Bus', 'Vm')).toBe(first)
  expect(resultTiles('run 1', 'Bus', 'Vm', 7)).not.toBe(first)
  expect(resultTiles('run 1', 'Bus', 'Vm')).toBe(first)
  // New results replace what is held, so the old tiles go once no plot draws them.
  const next = resultTiles('run 2', 'Bus', 'Vm')
  expect(next).not.toBe(first)
  expect(resultTiles('run 1', 'Bus', 'Vm')).not.toBe(first)
})

it('leaves a request that something replaced unanswered, and lets its tiles go', async () => {
  const request = vi.mocked(bridge.request)
  const first = resultTiles('run 9', 'Bus', 'Vm')
  // The page was shown another case while a plot's file was on its way. latkit would report a
  // rejection as the tiles' failure, though the plot is about to go.
  request.mockRejectedValueOnce(superseded())
  let answered = false
  const settle = () => (answered = true)
  void tile(first.url).then(settle, settle)
  await new Promise((resolve) => setTimeout(resolve))
  expect(answered).toBe(false)
  // A plot of the same results afterwards draws tiles of its own, with nothing left unanswered.
  expect(resultTiles('run 9', 'Bus', 'Vm')).not.toBe(first)
  // Any other failure is the tiles' own, and a file that arrives is passed on.
  request.mockRejectedValueOnce(new Error('The disk is gone.'))
  await expect(tile(first.url)).rejects.toThrow('The disk is gone.')
  request.mockResolvedValueOnce(Uint8Array.of(1, 2))
  await expect(tile(first.url)).resolves.toEqual(Uint8Array.of(1, 2))
  await expect(tile('https://tiles/frames.json')).rejects.toThrow('Not a file of results')
})

it('refreshes as a run grows, and once more after a draw for what arrived during it', async () => {
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
