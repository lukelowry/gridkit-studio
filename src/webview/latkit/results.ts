/** Recorded result fields as latkit time tiles, served by the results worker on demand. */

import { type Id, Tiles } from 'latkit'

import type { TileRequest } from '../../shared/data.js'
import { quiet } from '../../shared/errors.js'
import { bridge } from '../bridge.js'

const SCHEME = 'results:'

/** Parses the manifest URL for a recorded field, or a tile URL resolved against it. */
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

/** Latkit treats AbortError as a canceled read and retries real I/O failures. */
export async function tile(url: string): Promise<Uint8Array> {
  try {
    return await bridge.request('tile', tileRequest(url))
  } catch (error) {
    if (!quiet(error)) throw error
    throw new DOMException('The requested results are no longer current.', 'AbortError')
  }
}

/** Shares fetched tiles among the plots of one result, for as long as the result is open. */
export class ResultTiles {
  readonly #sources = new Map<string, Tiles>()
  constructor(readonly results: string) {}

  field(table: string, field: string, id?: Id): Tiles {
    const rows = id === undefined ? '*' : JSON.stringify(id)
    const url = `${SCHEME}${[this.results, table, field, rows].map(encodeURIComponent).join('/')}/frames.json`
    let source = this.#sources.get(url)
    if (!source) this.#sources.set(url, (source = new Tiles(url, url, { fetch: tile })))
    return source
  }
}

const recorded = new WeakMap<Tiles, number>()

/** A shared source needs one refresh per advance, including growth while its plots were closed. */
export function refreshResults(tiles: Tiles, frames: number): void {
  const previous = recorded.get(tiles)
  if (previous !== undefined && frames <= previous) return
  recorded.set(tiles, frames)
  if (previous !== undefined) tiles.refresh()
}
