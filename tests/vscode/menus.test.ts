/** Every command a menu, a title bar, a view's toolbar or the Command Palette offers, chosen where
 *  the user finds it, with what it did checked in the case, the views or VS Code. */

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

import { suite, suiteSetup, suiteTeardown, test } from 'mocha'
import type { Frame, Locator } from 'playwright-core'
import * as vscode from 'vscode'

import type { Entity } from '../../src/shared/document.js'
import {
  clipboard,
  custom,
  folder,
  frames,
  idle,
  simpleDialog,
  type TestHost,
  testHost,
  until,
  visible,
} from './harness.js'

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
  const header = (field: string): Locator => table.locator(`thead th[data-field="${field}"]`)
  const cells = (field: string): Locator => table.locator(`td[data-field="${field}"] .cell`)
  /** The row header of the element whose own id is `id`. */
  const row = (id: string): Locator =>
    table.locator('tbody th[scope="row"]', { hasText: new RegExp(`^${id}$`) })
  const selected = () => bench.session.selection?.id

  suiteSetup(async () => {
    bench = await testHost()
    table = await bench.show('case')
    await bench.caseType('Bus')
    await visible(table, 'tbody .cell')
  })

  test("copies a row's id, a value, and a column's path", async () => {
    const [bus] = bench.source.buses
    await bench.menu(row(String(bus!.number)), 'Copy ID')
    await until(async () => (await clipboard()) === String(bus!.number), 'the id copied')
    await bench.menu(cells('params.kv').first(), 'Copy Value')
    await until(async () => (await clipboard()) === String(bus!.params.kv), 'the value copied')
    await bench.menu(header('params.kv'), 'Copy Field Path')
    await until(async () => (await clipboard()) === 'params.kv', 'the path copied')
  })

  test('filters its rows by name from the title bar, and clears the filter from a cell', async () => {
    const { name } = bench.source.buses[12]!
    const names = () => table.locator('td[data-field="name"] .cell').allInnerTexts()
    await bench.title('case', 'Filter Rows')
    await bench.answer(name)
    await until(() => bench.session.table.filter === name, 'the filter kept')
    await until(async () => {
      const shown = await names()
      return shown.length > 0 && shown.every((each) => each.includes(name))
    }, 'only the rows whose name holds it')
    await bench.menu(cells('name').first(), 'Clear Filter')
    await until(() => !bench.session.table.filter, 'the filter cleared')
    await until(async () => (await names()).length > 1, 'every row again')
  })

  test('edits a value from its menu, which undo takes back', async () => {
    await bench.menu(cells('params.kv').first(), 'Edit Field')
    await bench.answer('345.0')
    await until(
      () => JSON.parse(bench.document.getText()).buses[0].params.kv === 345,
      'the value written',
    )
    await bench.undo('the value as it was')
  })

  test('chooses its columns from the title bar, and resets them from its menu', async () => {
    await bench.title('case', 'Choose Columns')
    await bench.check(['name'], false)
    await until(async () => (await header('name').count()) === 0, 'the name column gone')
    await visible(table, `thead th[data-field="params.kv"]`)
    await bench.title('case', 'Reset Columns')
    await visible(table, `thead th[data-field="name"]`)
  })

  test('goes to the bus of a branch the user picks, and to the bus a reference names', async () => {
    const branch = source().devices.find((device) => device.class === 'Branch')!
    for (const end of ['bus1', 'bus2'] as const) {
      const bus = branch.ports[end]
      await bench.caseType('Branch')
      await bench.menu(row(branch.id), 'Go to Referenced Element')
      // Each reference is offered by its field, with the element it names beside it.
      await bench.pick(new RegExp(String(bus) + '(?!\\d)'))
      await until(() => selected() === bus, end)
    }
    // Its second end, among the columns the title bar offers.
    await bench.caseType('Branch')
    await bench.title('case', 'Choose Columns')
    await bench.check(['bus2'])
    const reference = table
      .locator('tbody tr', {
        has: table.locator('th[scope="row"]', { hasText: new RegExp(`^${branch.id}$`) }),
      })
      .locator(`td[data-field="ports.bus2"] .cell`)
    await bench.menu(reference, 'Go to Referenced Element')
    await until(() => selected() === branch.ports.bus2, 'the bus it names')
  })

  test('reveals a row in the Diagram and in the source, and opens the source from its menu', async () => {
    const generator = source().devices.find((device) => device.class === 'Genrou')!
    await bench.caseType('Genrou')
    await bench.menu(row(generator.id), 'Reveal in Diagram')
    await until(() => custom()?.viewType === 'gridkitStudio.diagram', 'the Diagram in front')
    const diagram = await bench.view('diagram')
    await until(
      async () =>
        (
          await diagram.evaluate<{ entities: Entity[] } | null>('gridkitSelection()')
        )?.entities.some((item) => item.table === 'Genrou' && item.id === generator.id),
      'the Diagram selects it',
    )
    table = await bench.show('case')
    await bench.menu(row(generator.id), 'Reveal in Source')
    await until(() => {
      const editor = vscode.window.activeTextEditor
      return (
        editor?.document === bench.document &&
        editor.document.getText(editor.selection).includes(`"${generator.id}"`)
      )
    }, 'the source selects its element')
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
    await bench.title('case', 'Open JSON Source')
    await until(
      () =>
        vscode.window.visibleTextEditors.some(
          (editor) => editor.document.uri.toString() === bench.uri.toString(),
        ),
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
  /** Where the Network drew `id` in its latest frame, once the camera rests. */
  async function point(id: Entity) {
    await idle(network)
    const [x, y] = await until(
      () => network.evaluate<[number, number] | null>(`gridkitLocate(${JSON.stringify(id)})`),
      id + ' drawn',
    )
    return { x, y }
  }
  /** Right-click `id` where the Network draws it, and choose `item`. */
  async function menu(id: Entity, item: string) {
    await bench.title('editor', 'Fit All')
    await idle(network)
    await bench.menu(network.locator('canvas'), item, { on: id, at: () => point(id) })
  }

  suiteSetup(async () => {
    bench = await testHost()
    network = await bench.open('network')
  })

  test('reveals a bus in the Case panel from its menu', async () => {
    const { number } = bench.source.buses[3]!
    await menu({ table: 'Bus', id: number }, 'Reveal in Case Panel')
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
      await menu({ table: 'Branch', id: line.id }, 'Select Overlapping')
      await bench.pick('Branch ' + second.id, second.id)
      await until(() => bench.session.selection?.id === second.id, 'the second circuit selected')
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
    try {
      await bench.title('editor', 'Fit All')
      await idle(network)
      const fitted = await camera()
      await network.locator('canvas').hover()
      await bench.page.mouse.wheel(0, -800)
      await until(async () => !near(await camera(), fitted), 'zoomed in')
      await bench.title('editor', 'Fit All')
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

  test('edits the selected element from F2, which undo takes back', async () => {
    const [bus] = bench.source.buses
    bench.session.select({ table: 'Bus', id: bus!.number })
    await until(() => bench.keys()['gridkitStudio.hasSelection'] === true, 'a bus selected')
    await network.locator('canvas').press('F2')
    await bench.pick('name')
    await bench.answer('Renamed from F2')
    await until(() => bench.document.getText().includes('Renamed from F2'), 'the name written')
    await bench.undo('the name as it was')
    // Undo brought the case's text to the front.
    network = await bench.open('network')
  })

  test('changes projection from its own toolbar', async () => {
    await network.getByRole('button', { name: 'Tilt', exact: true }).click()
    await until(async () => (await camera())?.pitch === 45, 'tilted')
    await network.getByRole('button', { name: 'Flat', exact: true }).click()
    await until(async () => (await camera())?.pitch === 0, 'flat again')
  })

  test('opens its settings from the title bar', async () => {
    await bench.title('editor', 'Network Settings')
    await bench.settings(/gridkitStudio\.network/)
  })

  test('draws again from the start from its title bar', async () => {
    network = await bench.open('network')
    const drawn = (await idle(network)).frames
    await bench.title('editor', 'Reload View')
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
  /** Right-click the block, or its port `field`, where the Diagram draws it. */
  async function menu(field: string | undefined, item: string) {
    const at = async () => {
      await idle(diagram)
      const [x, y] = await until(
        () =>
          diagram.evaluate<[number, number] | null>(
            `gridkitLocate(${JSON.stringify({ table: 'Ieeest', id, ...(field ? { field } : {}) })}, ${JSON.stringify(field ?? null)})`,
          ),
        id + ' drawn',
      )
      if (!field) return { x, y }
      const point = await diagram.evaluate<[number, number] | null>(`(async () => {
        const center = [${x}, ${y}]
        for (let dx = 10; dx <= 200; dx += 8) {
          const probes = []
          for (const side of [-1, 1]) for (let dy = -100; dy <= 100; dy += 8)
            probes.push(gridkitPick([center[0] + side * dx, center[1] + dy], 5))
          const hit = (await Promise.all(probes)).flat().find(hit => hit.row.table === 'Ieeest' && hit.row.id === ${JSON.stringify(id)} && hit.port === ${JSON.stringify(field)})
          if (hit) return hit.point
        }
        return null
      })()`)
      assert.ok(point, 'The native picker locates the signal port')
      return { x: point[0], y: point[1] }
    }
    await bench.menu(diagram.locator('canvas'), item, { on: { table: 'Ieeest', id }, at })
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
    await menu(undefined, 'Delete Element')
    await until(() => !device(), 'the block gone from the case')
    await bench.settled()
    await bench.undo('the block back')
  })

  test('opens its settings from the title bar', async () => {
    diagram = await bench.open('diagram')
    await bench.title('editor', 'Diagram Settings')
    await bench.settings(/gridkitStudio\.diagram/)
  })
})

suite('Monitor menus', () => {
  let bench: TestHost
  let monitor: Frame
  const plotted = () =>
    monitor.evaluate<{ x: number[]; y: number[] | null }>(
      'document.querySelector("canvas").gridkitPlot().camera',
    )
  /** Choose `item` from the menu of the plot `n`. */
  async function menu(item: string, n = 0) {
    await bench.menu(monitor.locator('canvas').nth(n), item)
  }

  suiteSetup(async () => {
    bench = await testHost()
    await simpleDialog(true)
    await bench.results()
    monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
  })
  suiteTeardown(() => simpleDialog(undefined))

  test('narrows a plot to another element from its menu, and widens it to every element again', async () => {
    const id = bench.source.buses[4]!.number
    await menu('Choose Plot Element')
    // The picker names each bus, its id beside the name; typing an exact id finds that one.
    await bench.pick(new RegExp(String(id)), String(id))
    await until(() => bench.session.plots[0]?.id === id, 'the plot narrowed')
    await menu('Choose Plot Element')
    await bench.pick('Every element')
    await until(() => bench.session.plots[0]?.id === undefined, 'every bus plotted again')
  })

  test("sets a plot's value range from its menu, and fits its values again", async () => {
    await menu('Value Range')
    await bench.answer('0.5, 1.5')
    await until(async () => (await plotted()).y?.join() === '0.5,1.5', 'the range set')
    await menu('Value Range')
    await bench.answer('')
    // The plot fits its values again, which the next frame frames.
    await until(async () => {
      const { y } = await plotted()
      return y === null
    }, 'the values fitted')
  })

  test('narrows the time it shows and shows the whole run again from the title bar', async () => {
    await bench.title('monitor', 'Time Window')
    await bench.answer('0.2, 0.4')
    await until(async () => (await plotted()).x.join() === '0.2,0.4', 'the window narrowed')
    await bench.title('monitor', 'Time Window')
    await bench.answer('')
    const results = bench.session.results!
    await until(
      async () => (await plotted()).x.join() === (results.span ?? results.domain).join(),
      'every recorded time shown',
    )
    assert.equal(bench.session.window, undefined)
  })

  test('remounts its plots from the title bar', async () => {
    await monitor
      .locator('canvas')
      .first()
      .evaluate((canvas) => (canvas.dataset.before = ''))
    await bench.title('monitor', 'Reload View')
    await until(
      async () => (await monitor.locator('canvas[data-before]').count()) === 0,
      'remounted',
    )
    await visible(monitor, 'canvas[data-rendered=true]')
  })

  test('adds a plot from the title bar, and removes plots from their menu and close button', async () => {
    // One bus's voltage, beside which the voltage of every bus is another plot.
    bench.session.setPlots([{ from: 'Bus', field: 'Vm', id: bench.source.buses[4]!.number }])
    await bench.title('monitor', 'Add Plot')
    await bench.pick(/Vm/, 'Vm')
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
    await bench.title('monitor', 'Export CSV')
    await bench.dialog(csv.fsPath)
    await until(
      () =>
        stat(csv.fsPath).then(
          ({ size }) => size > 0,
          () => false,
        ),
      'the CSV written',
    )
    // GridKit's own CSV, as it wrote it.
    assert.ok(
      (await readFile(csv.fsPath)).equals(await readFile(bench.session.results!.path)),
      'the CSV is the run as GridKit wrote it',
    )
  })

  test('opens results from the title bar, and plots a signal they hold', async () => {
    const path = vscode.Uri.joinPath(folder(), 'Synthetic waveform.csv').fsPath
    await bench.title('monitor', 'Open Results')
    await bench.dialog(path)
    // A file read before and unchanged since shows as the results already read.
    await until(() => bench.session.results?.path === path, 'the opened results on show')
    await until(
      () => bench.session.plots.some((plot) => plot.field === 'Vm'),
      'its voltage plotted',
    )
    await visible(monitor, 'canvas[data-rendered=true]')
  })

  test('keeps decoded no more of the results than its setting says', async () => {
    const settings = vscode.workspace.getConfiguration('gridkitStudio')
    const path = vscode.Uri.joinPath(folder(), 'Synthetic waveform.csv').fsPath
    const kept = async () =>
      (await bench.studio.client.results.call('stats', {})) as { cacheBytes: number }
    try {
      await settings.update('resultCacheMiB', 0, vscode.ConfigurationTarget.Global)
      await bench.title('monitor', 'Open Results')
      await bench.dialog(path)
      await until(() => bench.session.results?.path === path, 'the results on show')
      await visible(monitor, 'canvas[data-rendered=true]')
      assert.equal((await kept()).cacheBytes, 0)
    } finally {
      await settings.update('resultCacheMiB', undefined, vscode.ConfigurationTarget.Global)
    }
  })

  test('clears the results from the title bar, and playback leaves the status bar', async () => {
    await bench.title('monitor', 'Clear Results')
    await until(() => !bench.session.results, 'no results')
    await visible(monitor, '.c-empty')
    await until(async () => (await bench.playback('Play').count()) === 0, 'playback gone')
  })
})

suite('Monitored Signals menus', () => {
  let bench: TestHost
  const vertexColor = () => bench.session.bindings.vertexColor

  suiteSetup(async () => {
    bench = await testHost()
    await bench.record('Bus', [])
    await bench.signals()
  })
  suiteTeardown(() => bench.reset())

  test('records every signal from its title bar, and no signal again', async () => {
    const before = bench.document.getText()
    await bench.title('signals', 'Record All Signals')
    await until(() => bench.recorded('Bus', 'Vm'), 'every bus records its voltage')
    await bench.title('signals', 'Record No Signals')
    await until(() => !bench.recorded('Bus', 'Vm'), 'no bus records its voltage')
    // Each was one edit, which undo takes back.
    await vscode.window.showTextDocument(bench.document)
    await vscode.commands.executeCommand('undo')
    await vscode.commands.executeCommand('undo')
    await until(() => bench.document.getText() === before, 'the case records as it did')
    await bench.settled()
  })

  test("maps a field from the action at its row's right, and changes it from its menu", async () => {
    // A field the case does not record maps as one it does, but offers no plot.
    assert.ok(!bench.signalOffered('Bus', 'Vm').includes('Plot Signal…'), 'nothing to plot')
    bench.signalMenu('Bus', 'Vm', 'Map To', true)
    await bench.check(['Vertex Color'])
    await until(
      () => vertexColor()?.table === 'Bus' && vertexColor()?.field === 'Vm',
      'the voltage colors the buses',
    )
    // Its menu offers what a mapped field's does, once the row hears of the mapping.
    await until(
      () => bench.signalOffered('Bus', 'Vm').includes('Remove Mapping'),
      'the row offers to remove the mapping',
    )
    bench.signalMenu('Bus', 'Vm', 'Mapping Range')
    await bench.answer('0.9, 1.1')
    await until(() => vertexColor()?.domain?.join() === '0.9,1.1', 'the range set')
    bench.signalMenu('Bus', 'Vm', 'Remove Mapping')
    await until(() => !vertexColor(), 'the mapping removed')
  })

  test('plots a recorded field of every element, and copies its path', async () => {
    await bench.record('Bus', ['Vm'])
    await until(
      () => bench.signalOffered('Bus', 'Vm').includes('Plot Signal…'),
      'the row offers to plot it',
    )
    bench.signalMenu('Bus', 'Vm', 'Plot Signal')
    await until(
      () =>
        bench.session.plots.some(({ from, field, id }) => from === 'Bus' && field === 'Vm' && !id),
      'every bus plotted',
    )
    await vscode.env.clipboard.writeText('')
    bench.signalMenu('Bus', 'Vm', 'Copy Field Path')
    await until(async () => (await clipboard()) === 'Vm', 'the path copied')
    await vscode.window.showTextDocument(bench.document)
    await vscode.commands.executeCommand('undo')
    await until(() => !bench.recorded('Bus', 'Vm'), 'the case records as it did')
    await bench.settled()
  })
})

suite('Studio commands', () => {
  let bench: TestHost

  suiteSetup(async () => {
    bench = await testHost()
    await simpleDialog(true)
  })
  suiteTeardown(() => simpleDialog(undefined))

  test('shows the log from the Command Palette', async () => {
    await bench.palette('Show Output')
    await until(async () => (await bench.panelShown()) === 'Output', 'the log on show')
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
    for (const [item, kind] of [
      ['Open Diagram', 'diagram'],
      ['Open Network', 'network'],
    ] as const) {
      bench.explorer(bench.uri, item)
      await until(
        () =>
          custom()?.viewType === 'gridkitStudio.' + kind &&
          custom()?.path === bench.uri.path.toLowerCase(),
        item,
      )
      await visible(await bench.view(kind), 'canvas[data-rendered=true]')
    }
  })
})
