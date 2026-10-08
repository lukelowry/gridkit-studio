/** Every command a menu, a title bar, a view's toolbar or the Command Palette offers, chosen where
 *  the user finds it, with what it did checked in the case, the views or VS Code. */

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import type { Frame, Locator } from 'playwright-core'
import * as vscode from 'vscode'

import { definitions } from '../../src/shared/preferences.js'
import {
  folder,
  frames,
  idle,
  simpleDialog,
  type TestHost,
  testHost,
  until,
  visible,
} from './harness.js'

/** The text on the clipboard. */
const clipboard = () => vscode.env.clipboard.readText()

/** The custom editor in front: its kind and file. */
function custom(): { viewType: string; path: string } | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input
  return input instanceof vscode.TabInputCustom
    ? { viewType: input.viewType, path: input.uri.path.toLowerCase() }
    : undefined
}

/** Whether two cameras agree, each number to within a hundredth of its size. */
function near(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) <= 0.01 * Math.max(1, Math.abs(b))
  if (a && b && typeof a === 'object' && typeof b === 'object')
    return Object.keys(b).every((key) => near(a[key as keyof object], b[key as keyof object]))
  return a === b
}

suite('Case panel menus', () => {
  let bench: TestHost
  let table: Frame
  const source = () =>
    JSON.parse(bench.text) as {
      devices: { class: string; id: string; ports: Record<string, number> }[]
    }
  const header = (field: string): Locator =>
    table.locator(`thead th[data-vscode-context*='"field":"${field}"']`)
  const cells = (field: string): Locator =>
    table.locator(`td[data-vscode-context*='"field":"${field}"'] .cell`)
  /** The row header of the element whose own id is `id`. */
  const row = (id: string): Locator =>
    table.locator('tbody th[scope="row"]', { hasText: new RegExp(`^${id}$`) })
  const selected = () => bench.session.selection?.id
  /** Choose `item` from the native menu of `target`. */
  async function menu(target: Locator, item: string) {
    await bench.menu(() => target.click({ button: 'right' }), item)
  }
  /** Show the elements of `type` from the title bar. */
  async function show(type: RegExp) {
    await bench.panelAction('Choose Type').click()
    await bench.page.locator('.quick-input-widget .monaco-list-row', { hasText: type }).click()
  }

  suiteSetup(async () => {
    bench = await testHost()
    table = await bench.show('case')
    await visible(table, 'tbody .cell')
  })

  test("copies a row's id, a value, and a column's path", async () => {
    const [bus] = bench.source.buses
    await menu(row(String(bus!.number)), 'Copy Identifier')
    await until(async () => (await clipboard()) === 'Bus/' + bus!.number, 'the id copied')
    await menu(cells('params.kv').first(), 'Copy Value')
    await until(async () => (await clipboard()) === String(bus!.params.kv), 'the value copied')
    await menu(header('params.kv'), 'Copy Field Path')
    await until(async () => (await clipboard()) === 'params.kv', 'the path copied')
  })

  test('chooses its columns from the title bar, and resets them from its menu', async () => {
    await bench.panelAction('Choose Columns').click()
    const picker = bench.page.locator('.quick-input-widget')
    await picker.locator('.monaco-list-row', { hasText: /^name/ }).click()
    await picker.getByRole('button', { name: 'OK' }).click()
    await until(async () => (await header('name').count()) === 0, 'the name column gone')
    await visible(table, `thead th[data-vscode-context*='"field":"params.kv"']`)
    await bench.menu(() => bench.more(bench.page.locator('.part.panel')), 'Reset Columns')
    await visible(table, `thead th[data-vscode-context*='"field":"name"']`)
  })

  test("goes to a branch's ends, and to the bus a reference names", async () => {
    const branch = source().devices.find((device) => device.class === 'Branch')!
    for (const [item, end] of [
      ['Go to Endpoint 1', 'bus1'],
      ['Go to Endpoint 2', 'bus2'],
    ] as const) {
      await show(/^Branch/)
      await menu(row(branch.id), item)
      await until(() => selected() === 'Bus/' + branch.ports[end], item)
    }
    // Its second end, among the columns the title bar offers.
    await show(/^Branch/)
    await bench.panelAction('Choose Columns').click()
    const picker = bench.page.locator('.quick-input-widget')
    await picker.locator('.monaco-list-row', { hasText: /^bus2/ }).click()
    await picker.getByRole('button', { name: 'OK' }).click()
    const reference = table
      .locator('tbody tr', {
        has: table.locator('th[scope="row"]', { hasText: new RegExp(`^${branch.id}$`) }),
      })
      .locator(`td[data-vscode-context*='"field":"ports.bus2"'] .cell`)
    await menu(reference, 'Go to Referenced Element')
    await until(() => selected() === 'Bus/' + branch.ports.bus2, 'the bus it names')
  })

  test('reveals a row in the Diagram and in the source, and opens the source from its menu', async () => {
    const generator = source().devices.find((device) => device.class === 'Genrou')!
    await show(/^GENROU/i)
    await menu(row(generator.id), 'Reveal in Diagram')
    await until(() => custom()?.viewType === 'gridkitStudio.diagram', 'the Diagram in front')
    const diagram = await bench.view('diagram')
    await until(
      async () =>
        (await diagram.evaluate<{ ids: string[] } | null>('gridkitSelection()'))?.ids.includes(
          'Genrou/' + generator.id,
        ),
      'the Diagram selects it',
    )
    table = await bench.show('case')
    await menu(row(generator.id), 'Reveal in Source')
    await until(() => {
      const editor = vscode.window.activeTextEditor
      return (
        editor?.document === bench.document &&
        editor.document.getText(editor.selection).includes(`"${generator.id}"`)
      )
    }, 'the source selects its element')
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    await bench.menu(() => bench.more(bench.page.locator('.part.panel')), 'Open JSON Source')
    await until(
      () => vscode.window.activeTextEditor?.document === bench.document,
      'the source in front',
    )
  })
})

suite('Network menus', () => {
  let bench: TestHost
  let network: Frame
  const camera = async () =>
    (await network.evaluate<{ camera: Record<string, unknown> } | null>('gridkitSelection()'))
      ?.camera
  /** Where the Network drew `id` in its latest frame. */
  const point = (id: string) =>
    until(
      () => network.evaluate<[number, number] | null>(`gridkitLocate(${JSON.stringify(id)})`),
      id + ' drawn',
    )
  /** Right-click `id` where the Network drew it, once the camera rests. */
  async function menu(id: string, item: string) {
    await idle(network)
    const [x, y] = await point(id)
    await bench.menu(
      () => network.locator('canvas').click({ button: 'right', position: { x, y } }),
      item,
    )
  }
  const editor = () => bench.page.locator('.part.editor')

  suiteSetup(async () => {
    bench = await testHost()
    network = await bench.open('network')
  })

  test('reveals a bus in the Case panel from its menu', async () => {
    const { number } = bench.source.buses[3]!
    await menu('Bus/' + number, 'Reveal in Case')
    const table = await bench.view('case')
    await until(
      async () =>
        (
          await table
            .locator('tbody tr.selected th')
            .innerText()
            .catch(() => '')
        ).trim() === String(number),
      'its row selected',
    )
  })

  test('chooses between the circuits of a double line drawn as one', async () => {
    const source = JSON.parse(bench.text) as { devices: { class: string; id: string }[] }
    const line = source.devices.find((device) => device.class === 'Branch')!
    const second = { ...line, id: line.id + '_parallel' }
    source.devices.push(second)
    await bench.replace(JSON.stringify(source, null, 2))
    await bench.settled()
    try {
      network = await bench.open('network')
      await menu('Branch/' + line.id, 'Select Overlapping')
      await bench.page
        .locator('.quick-input-widget .monaco-list-row', { hasText: 'Branch/' + second.id })
        .click()
      await until(
        () => bench.session.selection?.id === 'Branch/' + second.id,
        'the second circuit selected',
      )
      // The Case panel follows it to its row.
      const table = await bench.view('case')
      await until(
        async () =>
          (
            await table
              .locator('tbody tr.selected th')
              .innerText()
              .catch(() => '')
          ).trim() === second.id,
        'its row selected',
      )
    } finally {
      await bench.replace(bench.text)
      await bench.settled()
      network = await bench.open('network')
    }
    // The circuit gone from the case, nothing stays selected.
    await until(() => !bench.session.selection, 'the selection let go')
  })

  test('fits from the editor title bar, and turns from its own toolbar', async () => {
    // This test exercises motion; the host's accessibility preference may disable orbit.
    await bench.page.emulateMedia({ reducedMotion: 'no-preference' })
    const fit = bench.page.locator('.part.editor').getByRole('button', { name: /^Fit All/ })
    try {
      await fit.click()
      await idle(network)
      const fitted = await camera()
      await network.locator('canvas').hover()
      await bench.page.mouse.wheel(0, -800)
      await until(async () => !near(await camera(), fitted), 'zoomed in')
      await fit.click()
      await until(async () => near(await camera(), fitted), 'fitted again')
      const turn = network.getByRole('button', { name: 'Auto-rotate' })
      await turn.click()
      await until(async () => (await turn.getAttribute('aria-pressed')) === 'true', 'turning')
      const drawn = await frames(network)
      await until(async () => (await frames(network)) > drawn + 10, 'drawn as it turns')
      await turn.click()
      await until(async () => (await turn.getAttribute('aria-pressed')) === 'false', 'still')
    } finally {
      await bench.page.emulateMedia({ reducedMotion: null })
    }
  })

  test('changes projection from the Command Palette', async () => {
    await bench.palette('Projection…')
    await bench.page.locator('.quick-input-widget .monaco-list-row', { hasText: /^tilt/ }).click()
    await until(async () => (await camera())?.projection === 'tilt', 'tilted')
    await network.getByRole('button', { name: 'Flat', exact: true }).click()
    await until(async () => (await camera())?.projection === 'flat', 'flat again')
  })

  test('chooses its colormap and opens its settings from the title bar', async () => {
    const settings = () => vscode.workspace.getConfiguration('gridkitStudio', bench.uri)
    const before = settings().get('network.colormap')
    const setting = definitions.find((each) => each.id === 'network.colormap')!
    const other = ('options' in setting ? setting.options : []).find(
      (option) => option.value !== before,
    )!
    try {
      await bench.menu(() => bench.more(editor()), 'Colormap')
      await bench.page
        .locator('.quick-input-widget .monaco-list-row', {
          hasText: new RegExp(`^${other.label}$`),
        })
        .click()
      await until(() => settings().get('network.colormap') === other.value, 'the colormap set')
    } finally {
      await settings().update('network.colormap', undefined, vscode.ConfigurationTarget.Workspace)
    }
    await bench.menu(() => bench.more(editor()), 'Network Settings')
    await bench.settings(/gridkitStudio\.network/)
  })

  test('draws again from the start from its title bar', async () => {
    network = await bench.open('network')
    // At rest, so the title bar's menu holds still under the pointer.
    const drawn = (await idle(network)).frames
    await bench.menu(() => bench.more(editor()), 'Reload Visualization')
    await until(async () => (await frames(network).catch(() => Infinity)) < drawn, 'a new drawing')
    await visible(network, 'canvas[data-rendered=true]')
  })
})

suite('Diagram menus', () => {
  let bench: TestHost
  let diagram: Frame
  /** The power system stabilizer the suite rewires and deletes. */
  const id = '30_1_ieeest'
  const device = () =>
    (
      JSON.parse(bench.document.getText()) as {
        devices: { id: string; ports: Record<string, number | null> }[]
      }
    ).devices.find((each) => each.id === id)
  const camera = async () =>
    JSON.stringify(
      (await diagram.evaluate<{ camera: unknown } | null>('gridkitSelection()'))?.camera,
    )
  /** Right-click the block, or its port `field`, where the Diagram drew it. */
  async function menu(field: string | undefined, item: string) {
    await idle(diagram)
    const [x, y] = await until(
      () =>
        diagram.evaluate<[number, number] | null>(
          `gridkitLocate(${JSON.stringify('Ieeest/' + id)}, ${JSON.stringify(field ?? null)})`,
        ),
      id + ' drawn',
    )
    await bench.menu(
      () => diagram.locator('canvas').click({ button: 'right', position: { x, y } }),
      item,
    )
  }

  suiteSetup(async () => {
    bench = await testHost()
    diagram = await bench.open('diagram')
  })

  test('zooms to a block from its menu', async () => {
    const before = await camera()
    await menu(undefined, 'Zoom to Neighborhood')
    await until(async () => (await camera()) !== before, 'the Diagram frames it')
  })

  test('disconnects a port from its menu, and undo wires it again', async () => {
    await menu('ports.output', 'Disconnect Port')
    await until(() => device()?.ports.output == null, 'the port disconnected in the case')
    await bench.settled()
    await bench.undo('the port wired again')
  })

  test('deletes a block from its menu, and undo brings it back', async () => {
    diagram = await bench.open('diagram')
    await menu(undefined, 'Delete Diagram Element')
    await until(() => !device(), 'the block gone from the case')
    await bench.settled()
    await bench.undo('the block back')
  })

  test('opens its settings from the title bar', async () => {
    diagram = await bench.open('diagram')
    await bench.menu(() => bench.more(bench.page.locator('.part.editor')), 'Diagram Settings')
    await bench.settings(/gridkitStudio\.diagram/)
  })
})

suite('Monitor menus', () => {
  let bench: TestHost
  let monitor: Frame
  const panel = () => bench.page.locator('.part.panel')
  const plotted = () =>
    monitor.evaluate<{ x: number[]; y: number[] }>(
      'document.querySelector("canvas").gridkitPlot().camera',
    )
  const input = () => bench.page.locator('.quick-input-widget input')
  const row = (text: string | RegExp) =>
    bench.page.locator('.quick-input-widget .monaco-list-row', { hasText: text }).first()
  /** Choose `item` from the native menu of the plot `n`. */
  async function menu(item: string, n = 0) {
    await bench.menu(() => monitor.locator('canvas').nth(n).click({ button: 'right' }), item)
  }
  /** Choose `item` from the title bar's More Actions. */
  async function more(item: string) {
    await bench.menu(() => bench.more(panel()), item)
  }

  suiteSetup(async () => {
    bench = await testHost()
    await simpleDialog(true)
    await bench.results()
    monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
  })
  suiteTeardown(() => simpleDialog(undefined))

  test('narrows a plot to another element from its menu', async () => {
    const id = 'Bus/' + bench.source.buses[4]!.number
    await menu('Choose Plot Element')
    await input().fill(id)
    await row(id).click()
    await until(() => bench.session.plots[0]?.id === id, 'the plot narrowed')
  })

  test("sets a plot's value range from its menu", async () => {
    await menu('Plot Value Range')
    await input().fill('0.5, 1.5')
    await input().press('Enter')
    await until(async () => (await plotted()).y.join() === '0.5,1.5', 'the range set')
  })

  test('narrows the time it shows and fits it back from the title bar', async () => {
    await more('Time Window')
    await input().fill('0.2, 0.4')
    await input().press('Enter')
    await until(async () => (await plotted()).x.join() === '0.2,0.4', 'the window narrowed')
    await more('Fit Recorded Time')
    const run = bench.session.run!
    await until(
      async () => (await plotted()).x.join() === (run.span ?? run.domain).join(),
      'the whole run shown',
    )
    assert.equal(bench.session.window, undefined)
  })

  test('remounts its plots from the title bar', async () => {
    await monitor
      .locator('canvas')
      .first()
      .evaluate((canvas) => (canvas.dataset.before = ''))
    await more('Reload Monitor')
    await until(
      async () => (await monitor.locator('canvas[data-before]').count()) === 0,
      'remounted',
    )
    await visible(monitor, 'canvas[data-rendered=true]')
  })

  test('repeats playback as chosen from the Command Palette', async () => {
    await bench.palette('Repeat Mode…')
    await row(/^Bounce/).click()
    await until(() => bench.session.transport.state.loop === 'pingpong', 'bouncing')
  })

  test('adds a plot from the title bar, and removes plots from their menu and close button', async () => {
    await bench.panelAction('Add Plot').click()
    await row('Vm').click()
    await until(() => bench.session.plots.length === 2, 'a second plot')
    await until(
      async () => (await monitor.locator('canvas').count()) === 2,
      'drawn beside the first',
    )
    await menu('Remove Plot', 1)
    await until(() => bench.session.plots.length === 1, 'removed from its menu')
    const lane = monitor.locator('.lane').first()
    await lane.hover()
    await lane.getByRole('button', { name: /^Remove / }).click()
    await until(() => bench.session.plots.length === 0, 'removed by its button')
  })

  test('exports the run as CSV from the title bar', async () => {
    const csv = vscode.Uri.joinPath(folder(), 'Exported run.csv')
    await more('Export CSV')
    await bench.dialog(csv.fsPath)
    await until(
      () =>
        stat(csv.fsPath).then(
          ({ size }) => size > 0,
          () => false,
        ),
      'the CSV written',
    )
    const lines = (await readFile(csv.fsPath, 'utf8')).trim().split('\n')
    assert.ok(lines.length > 1, 'a header and samples')
  })

  test('imports results from the title bar, and plots one of their signals', async () => {
    const before = bench.session.run!.id
    await more('Import Results')
    await bench.dialog(vscode.Uri.joinPath(folder(), 'Synthetic waveform.csv').fsPath)
    await row('Bus.Vm').click()
    await until(() => bench.session.run?.id !== before, 'the imported run on show')
    await until(
      () => bench.session.plots.some((plot) => plot.field === 'Vm'),
      'its voltage plotted',
    )
    await visible(monitor, 'canvas[data-rendered=true]')
  })

  test('clears the results from the title bar, and playback leaves the status bar', async () => {
    await more('Clear Results')
    await until(() => !bench.session.run, 'no results')
    await visible(monitor, '.c-empty')
    await until(async () => (await bench.playback('Play').count()) === 0, 'playback gone')
  })
})

suite('Studio commands', () => {
  let bench: TestHost

  suiteSetup(async () => {
    bench = await testHost()
    await simpleDialog(true)
  })
  suiteTeardown(() => simpleDialog(undefined))

  test("says where GridKit runs and shows its output from the Simulation view's menu", async () => {
    await bench.show('simulation')
    const header = bench.page.locator('.pane-header', { hasText: /^Simulation/ })
    await bench.menu(() => bench.more(header), 'Where GridKit Runs')
    await bench.settings(/gridkitStudio\.gridkitPath/)
    await bench.menu(() => bench.more(header), 'Show Simulation Output')
    await until(async () => (await bench.panelShown()) === 'Output', 'the output on show')
  })

  test('validates the case and diagnoses performance from the Command Palette', async () => {
    await bench.palette('Validate Case')
    await until(async () => /^Problems/.test(await bench.panelShown()), 'Problems on show')
    await bench.palette('Show Performance Diagnostics')
    await until(async () => (await bench.panelShown()) === 'Output', 'the diagnostics on show')
  })

  test('opens a case from the Command Palette, and either view of it from the Explorer', async () => {
    const copy = vscode.Uri.joinPath(folder(), 'Opened.case.json')
    await vscode.workspace.fs.copy(bench.uri, copy, { overwrite: true })
    await bench.palette('Open Case…')
    await bench.dialog(copy.fsPath)
    await until(
      () =>
        custom()?.viewType === 'gridkitStudio.network' &&
        custom()?.path === copy.path.toLowerCase(),
      'its Network in front',
    )
    await vscode.commands.executeCommand('revealInExplorer', bench.uri)
    const file = bench.page
      .locator('.part.sidebar')
      .getByRole('treeitem', { name: /IEEE39\.case\.json/ })
    for (const [item, kind] of [
      ['Open Diagram', 'diagram'],
      ['Open Network', 'network'],
    ] as const) {
      await bench.menu(() => file.click({ button: 'right' }), item)
      await until(
        () =>
          custom()?.viewType === 'gridkitStudio.' + kind &&
          custom()?.path === bench.uri.path.toLowerCase(),
        item,
      )
      // Drawn and at rest before the next menu opens over it.
      const view = await bench.view(kind)
      await visible(view, 'canvas[data-rendered=true]')
      await idle(view)
    }
  })
})
