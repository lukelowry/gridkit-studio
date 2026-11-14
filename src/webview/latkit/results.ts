/** The recorded fields of results as latkit's time tiles: the files the results worker reads from
 *  its store, which a view fetches as its plot window and camera need them. */

import { type Id, Tiles } from 'latkit'

import type { TileRequest } from '../../shared/data.js'
import { bridge } from '../bridge.js'

const SCHEME = 'results:'

/** What the file at `url` is, a URL `resultTiles` made or latkit resolved against one. */
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

/** One fetch for every tiles of the page, so tiles of one manifest share what they fetched. */
const fetch = (url: string) => bridge.request('tile', tileRequest(url))

/** The time tiles of `field` of `table` in the results `results`: every row recorded, or the one
 *  `id` names. Each is named by its URL. */
export function resultTiles(results: string, table: string, field: string, id?: Id): Tiles {
  const rows = id === undefined ? '*' : JSON.stringify(id)
  const url = `${SCHEME}${[results, table, field, rows].map(encodeURIComponent).join('/')}/frames.json`
  return new Tiles(url, url, { fetch })
}

/** What refreshes `tiles` as a run records more: at once, then again once `drawn` says the view
 *  drew what that fetched, if more came meanwhile. A run that records faster than the page draws is
 *  plotted as often as the page can draw it, and a fetch is never started over before it lands. */
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
          // A view gone meanwhile has nothing left to draw.
          await drawn()?.catch(() => {})
        } while (again)
      } finally {
        // In the same step as the last check of `again`, so no refresh asked for falls between.
        busy = false
      }
    })()
  }
}
