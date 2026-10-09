/** VS Code's own popups, as the user meets them: each shows what the manifest places there, and
 *  choosing an item runs its command. Every other suite reads what a place offers from the manifest
 *  and runs it as VS Code would, which this suite checks against VS Code itself, once for each kind
 *  of popup. A popup may drop a click or close unasked, so each gesture starts over until it takes,
 *  on an item that does the same each time. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import * as vscode from 'vscode'

import { named } from '../menus.js'
import { idle, type TestHost, testHost, until, visible } from './harness.js'

/** The text on the clipboard. */
const clipboard = () => vscode.env.clipboard.readText()

/** The custom editor in front. */
const front = () => {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  return input instanceof vscode.TabInputCustom ? input.viewType : undefined
}

/** Whether a popup showed each of `titles`, and only those when `only`. */
function showed(shown: readonly string[], titles: readonly string[], only: boolean) {
  for (const title of titles)
    assert.ok(shown.includes(title), `${title} shown: ${shown.join(', ')}`)
  if (only) assert.deepEqual([...shown].sort(), [...titles].sort())
}

suite('Native menus', () => {
  let bench: TestHost

  suiteSetup(async () => {
    bench = await testHost()
  })

  test('places commands only by context keys Studio or VS Code sets', () => {
    // A view's menu takes the keys its context carries, which the unit contract checks.
    const known = new Set([
      ...Object.keys(bench.keys()),
      'view',
      'activeCustomEditorId',
      'resourceFilename',
    ])
    for (const { place, when } of bench.menus.clauses())
      if (place !== 'webview/context')
        for (const key of named(when)) assert.ok(known.has(key), `${key}, in ${place}: ${when}`)
  })

  test("a cell of the Case panel shows its menu's items, and runs the one chosen", async () => {
    const table = await bench.show('case')
    await bench.caseType('Bus')
    await visible(table, `td[data-vscode-context*='"field":"params.kv"'] .cell`)
    const cell = table.locator(`td[data-vscode-context*='"field":"params.kv"'] .cell`).first()
    const offered = await bench.offered(cell)
    await vscode.env.clipboard.writeText('')
    const kv = String(bench.source.buses[0]!.params.kv)
    const shown = await bench.native(
      () => cell.click({ button: 'right' }),
      'Copy Value',
      async () => (await clipboard()) === kv,
    )
    showed(shown, offered, true)
  })

  test("a bus on the Network shows its menu's items, and runs the one chosen", async () => {
    const network = await bench.open('network')
    const id = 'Bus/' + bench.source.buses[2]!.number
    await idle(network)
    const [x, y] = await until(
      () => network.evaluate<[number, number] | null>(`gridkitLocate(${JSON.stringify(id)})`),
      id + ' drawn',
    )
    const canvas = network.locator('canvas')
    const offered = await bench.offered(canvas, { x, y })
    await vscode.env.clipboard.writeText('')
    const shown = await bench.native(
      () => canvas.click({ button: 'right', position: { x, y } }),
      'Copy Identifier',
      async () => (await clipboard()) === id,
    )
    showed(shown, offered, true)
  })

  test("a plot in the Monitor shows its menu's items, and runs the one chosen", async () => {
    await bench.results()
    const monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    const canvas = monitor.locator('canvas').first()
    const offered = await bench.offered(canvas)
    const search = bench.page.locator('.settings-editor .search-container .view-lines')
    const shown = await bench.native(
      () => canvas.click({ button: 'right' }),
      'Monitor Settings',
      async () => /gridkitStudio\.monitor/.test(await search.innerText().catch(() => '')),
    )
    showed(shown, offered, true)
    await bench.settings(/gridkitStudio\.monitor/)
  })

  test("the editor's title bar shows Studio's More Actions, and runs the one chosen", async () => {
    await bench.open('network')
    const offered = bench.menus
      .offered('editor/title', { ...bench.keys(), activeCustomEditorId: front() })
      .filter((each) => each.group !== 'navigation' && !each.group?.startsWith('navigation@'))
      .map((each) => each.title)
    const more = bench.page
      .locator('.part.editor')
      .getByRole('button', { name: /More Actions/ })
      .first()
    const search = bench.page.locator('.settings-editor .search-container .view-lines')
    const shown = await bench.native(
      () => more.click({ timeout: 2000 }),
      'Network Settings',
      async () => /gridkitStudio\.network/.test(await search.innerText().catch(() => '')),
    )
    // VS Code adds its own items for the editor beside Studio's.
    showed(shown, offered, false)
    await bench.settings(/gridkitStudio\.network/)
  })

  test("the Explorer's menu on a case shows Studio's items, and runs the one chosen", async () => {
    await vscode.commands.executeCommand('revealInExplorer', bench.uri)
    const file = bench.page
      .locator('.part.sidebar')
      .getByRole('treeitem', { name: /IEEE39\.case\.json/ })
    const offered = bench.menus
      .offered('explorer/context', { ...bench.keys(), resourceFilename: 'IEEE39.case.json' })
      .map((each) => each.title)
    const shown = await bench.native(
      () => file.click({ button: 'right', timeout: 2000 }),
      'Open Diagram',
      () => front() === 'gridkitStudio.diagram',
    )
    // VS Code's own items for a file come first.
    showed(shown, offered, false)
    await visible(await bench.view('diagram'), 'canvas[data-rendered=true]')
  })

  test('the Command Palette runs a command by its title', async () => {
    bench.menus.palette('Validate Case', bench.keys())
    await vscode.commands.executeCommand('workbench.action.showCommands')
    const title = 'GridKit Studio: Validate Case'
    await bench.pick(title, '>' + title)
    await until(async () => /^Problems/.test(await bench.panelShown()), 'Problems on show')
  })
})
