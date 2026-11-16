/** Recorded result fields as latkit time tiles, served by the results worker on demand. */

import { type Id, Tiles } from 'latkit'

import type { TileRequest } from '../../shared/data.js'
import { bridge } from '../bridge.js'

const SCHEME = 'results:'

/** Parses a URL that `resultTiles` made, or that latkit resolved against one. */
export function tileRequest(url: string): TileRequest {
  if (!url.startsWith(SCHEME)) throw new Error(`Not a file of results: ${url}`)
  const [results, table, field, rows, ...rest] = url
    .slice(SCHEME.length)
    .split('/')
    .map(decodeURIComponent)
  const name = rest.join('/')
  const span = /^(\d+)\/(\d+)\.latk$/.exec(name)
  if (
    !results ||
    !table ||
    !field ||
    !rows ||
    !(span || name === 'frames.json' || name === 'base.latk')
  )
    throw new Error(`Not a file of results: ${url}`)
  return {
    results,
    table,
    field,
    ...(rows !== '*' && { id: JSON.parse(rows) as Id }),
    file: span ? { level: Number(span[1]), index: Number(span[2]) } : (name as 'frames.json'),
  }
}

const fetch = (url: string) => bridge.request('tile', tileRequest(url))

/** The tiles of the results last asked for, by URL. latkit shares what it fetched only among the
 *  views of one `Tiles`, and keeps it while that `Tiles` lives. So every plot of a field draws the
 *  same one, a plot that closes and opens again fetches nothing, and other results' tiles are let
 *  go. */
let held: { readonly results: string; readonly tiles: Map<string, Tiles> } | undefined

/** Time tiles of `table`'s `field`: every recorded row, or only `id`. Named by their URL. */
export function resultTiles(results: string, table: string, field: string, id?: Id): Tiles {
  const rows = id === undefined ? '*' : JSON.stringify(id)
  const url = `${SCHEME}${[results, table, field, rows].map(encodeURIComponent).join('/')}/frames.json`
  if (held?.results !== results) held = { results, tiles: new Map() }
  let tiles = held.tiles.get(url)
  if (!tiles) held.tiles.set(url, (tiles = new Tiles(url, url, { fetch })))
  return tiles
}

/** Refreshes `tiles` as a run records more: at once, then again after `drawn` resolves if more
 *  arrived meanwhile. A fast run plots as often as the page can draw, and no fetch restarts. */
export function refresher(
  tiles: Pick<Tiles, 'refresh'>,
  drawn: () => Promise<void> | undefined,
): () => void {
  let busy = false
  let again = false
  return () => {
    if (busy) {
      again = true
      return
    }
    busy = true
    void (async () => {
      try {
        do {
          again = false
          tiles.refresh()
          // A view closed meanwhile has nothing left to draw.
          await drawn()?.catch(() => {})
        } while (again)
      } finally {
        // In the same task as the last check of `again`, so no refresh request is lost.
        busy = false
      }
    })()
  }
}
