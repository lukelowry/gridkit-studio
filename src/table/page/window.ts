import type { GridWindow } from '@latkit/model'

import { SharedCache } from '../../cache.js'
import type { TableView } from '../query.js'

const PAGE = 128
/** A small aligned page cache prevents row-by-row scrolling from becoming row-by-row RPC. */
export class WindowCache {
  private readonly pages = new SharedCache<GridWindow>(
    8 * 1024 * 1024,
    (page) =>
      page.rows.reduce(
        (bytes, row) =>
          bytes + 32 + 2 * (row.label.length + row.cells.reduce((n, cell) => n + cell.length, 0)),
        0,
      ),
    12,
  )
  constructor(readonly view: TableView) {}
  async read(
    offset: number,
    count: number,
    columns: readonly number[],
    signal?: AbortSignal,
  ): Promise<GridWindow> {
    const rows: GridWindow['rows'][number][] = []
    const end = Math.min(offset + count, this.view.total)
    for (let start = Math.floor(offset / PAGE) * PAGE; start < end; start += PAGE) {
      const at = start
      const page = await this.pages.get(
        JSON.stringify([at, columns]),
        (abort) => this.view.read(at, PAGE, columns, abort),
        signal,
      )
      rows.push(...page.rows.slice(Math.max(0, offset - start), end - start))
    }
    signal?.throwIfAborted()
    return { rows, total: this.view.total }
  }
  close() {
    this.pages.clear()
    this.view.close()
  }
}
