/** The Case panel and the Network as one selection, and the menus each offers: a row shows in the
 *  Network, a pick in the Network shows in the table, and the table's own menus order, filter, and
 *  hide its rows. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import type { Frame, Locator } from 'playwright-core'
import * as vscode from 'vscode'

import { idle, type TestHost, testHost, until, visible } from './harness.js'

/** What the Network shows selected, and its camera, as `gridkitSelection()` reports them. */
type Shown = { ids: string[]; camera: unknown }

suite('Links', () => {
  let bench: TestHost
  let network: Frame
  let table: Frame
  const shown = () => network.evaluate<Shown | null>('gridkitSelection()')
  const header = (field: string): Locator =>
    table.locator(`thead th[data-vscode-context*='"field":"${field}"']`)
  const cells = (field: string): Locator =>
    table.locator(`td[data-vscode-context*='"field":"${field}"'] .cell`)
  const offered = (item: string) =>
    bench.page.getByRole('menuitem', { name: new RegExp('^' + item) }).count()
  /** Choose `item` from the native menu of `target`. */
  async function menu(target: Locator, item: string) {
    await target.click({ button: 'right' })
    await bench.choose(item)
  }
  /** Where the Network drew `id` in its latest frame. */
  const point = (id: string) =>
    until(
      () => network.evaluate<[number, number] | null>(`gridkitLocate(${JSON.stringify(id)})`),
      id + ' drawn',
    )

  suiteSetup(async () => {
    bench = await testHost()
    network = await bench.open('network')
    table = await bench.show('case')
    await visible(table, 'tbody .cell')
  })

  test('shows a device the Network does not draw by the bus it joins', async () => {
    bench.studio.select(bench.key, { id: 'Genrou/30_1_genrou' })
    await until(async () => (await shown())?.ids.join() === 'Bus/30', 'its bus selected')
    // The table follows to the generators, with the generator's row selected.
    await until(
      async () =>
        (
          await table
            .locator('tbody tr.selected th')
            .innerText()
            .catch(() => '')
        ).trim() === '30_1_genrou',
      'its row selected in the table',
    )
  })

  test('brings a bus picked in the Network into view in the table', async () => {
    const id = 'Bus/' + bench.source.buses.at(-1)!.number
    const [x, y] = await point(id)
    await network.locator('canvas').click({ position: { x, y } })
    await until(() => bench.session.selection?.id === id, 'the pick selects the bus')
    await until(async () => {
      const row = await table.locator('tbody tr.selected').boundingBox()
      const area = await table.locator('.case__scroll').boundingBox()
      return !!row && !!area && row.y >= area.y && row.y + row.height <= area.y + area.height + 1
    }, 'its row scrolled into view')
    await bench.capture('links-picked')
  })

  test('moves the selection with the arrow keys, and the Network follows', async () => {
    const first = cells('params.kv').first()
    await first.click()
    const from = bench.session.selection?.id
    await first.press('ArrowDown')
    await until(
      () => !!bench.session.selection && bench.session.selection.id !== from,
      'the next row selected',
    )
    const id = bench.session.selection!.id
    await until(async () => (await shown())?.ids.includes(id), 'the Network selects it too')
  })

  test('zooms the Network to the neighborhood of a row', async () => {
    const before = JSON.stringify((await shown())?.camera)
    await menu(table.locator('tbody th[scope="row"]').nth(5), 'Zoom to Neighborhood')
    await until(
      async () => JSON.stringify((await shown())?.camera) !== before,
      'the Network frames it',
    )
  })

  test('offers each thing its own menu', async () => {
    // A bus in the Network, the one just framed: where else it shows, and what to do with the
    // whole element. The camera rests first, so the bus is where it was found.
    await idle(network)
    const [x, y] = await point(bench.session.selection!.id)
    await network.locator('canvas').click({ button: 'right', position: { x, y } })
    for (const item of [
      'Reveal in Source',
      'Reveal in Case',
      'Zoom to Neighborhood',
      'Plot Signal',
    ])
      await bench.offered(item)
    assert.equal(await offered('Reveal in Network'), 0, 'the Network does not reveal in itself')
    assert.equal(await offered('Map To'), 0, 'a whole element maps nothing')
    await bench.page.keyboard.press('Escape')
    // A cell: its value.
    await cells('params.kv').first().click({ button: 'right' })
    for (const item of ['Edit Field', 'Reveal in Network', 'Filter to This Value', 'Copy Value'])
      await bench.offered(item)
    assert.equal(await offered('Sort Ascending'), 0, 'a cell does not order its column')
    await bench.capture('links-cell-menu')
    await bench.page.keyboard.press('Escape')
  })

  test('orders, filters and hides the rows from their menus', async () => {
    await menu(header('params.kv'), 'Sort Descending')
    await until(
      async () => (await header('params.kv').getAttribute('aria-sort')) === 'descending',
      'sorted',
    )
    // The order on show is not offered again.
    await header('params.kv').click({ button: 'right' })
    await bench.offered('Sort Ascending')
    assert.equal(await offered('Sort Descending'), 0)
    await bench.choose('Clear Sort')
    await until(
      async () => (await header('params.kv').getAttribute('aria-sort')) === 'none',
      'unsorted',
    )
    // One name: the rows holding it, until the filter is cleared.
    const name = (await cells('name').first().innerText()).trim()
    await menu(cells('name').first(), 'Filter to This Value')
    await visible(table, '[data-testid="case-equal"]')
    await until(async () => {
      const names = (await cells('name').allInnerTexts()).map((text) => text.trim())
      return names.length > 0 && names.every((text) => text === name)
    }, 'only rows of that name')
    await table.locator('[data-testid="case-equal"]').click()
    await until(
      async () => (await cells('name').count()) === bench.source.buses.length,
      'every row again',
    )
    await menu(header('params.kv'), 'Hide Column')
    await until(async () => (await header('params.kv').count()) === 0, 'the column hidden')
    await vscode.commands.executeCommand('gridkitStudio.resetColumns')
    await visible(table, `thead th[data-vscode-context*='"field":"params.kv"']`)
  })
})
