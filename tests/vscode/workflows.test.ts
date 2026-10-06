/** What a user does with a case, end to end against real GridKit: find a bus by name and see it on
 *  the Network, change it and take the change back, fault it and run, read its voltage drop in the
 *  Monitor, and color the Network by that voltage. Each step goes through the views and menus. */

import assert from 'node:assert/strict'

import type { RowsBlock } from '@latkit/model'
import { suite, suiteSetup, test } from 'mocha'
import type { Frame, Locator } from 'playwright-core'

import { rowsOf } from '../../src/shared/cells.js'
import { frames, type TestHost, testHost, until, visible } from './harness.js'

suite('Workflows', function () {
  // A run of the whole case takes as long as GridKit does.
  this.timeout(600_000)
  this.bail(true)
  let bench: TestHost
  let network: Frame
  let table: Frame
  let bus: TestHost['source']['buses'][number]
  let id: string
  const picker = () => bench.page.locator('.quick-input-widget')
  /** The bus's row in the Case panel. */
  const row = () =>
    table
      .locator('tbody tr')
      .filter({ has: table.locator('th[scope="row"]', { hasText: new RegExp(`^${bus.number}$`) }) })
  const kv = () => row().locator(`td[data-vscode-context*='"field":"params.kv"']`)
  /** Choose `item` from the native menu of `target`. */
  async function menu(target: Locator, item: string) {
    await target.click({ button: 'right' })
    await bench.choose(item)
  }
  /** The bus's recorded voltage at time `t` of run `run`. */
  async function voltage(run: string, t: number): Promise<number> {
    const blocks = await bench.studio.client.call('query', {
      uri: bench.key,
      version: (await bench.current()).version,
      run,
      query: {
        kind: 'rows',
        from: 'Bus',
        select: ['Vm'],
        ids: true,
        rows: { kind: 'ids', ids: [id] },
        at: t,
      },
    })
    return rowsOf(blocks as RowsBlock[])[0]!.values.Vm as number
  }

  suiteSetup(async function () {
    bench = await testHost()
    if (!(await bench.gridkit())) this.skip()
    network = await bench.open('network')
    table = await bench.show('case')
    await visible(table, 'tbody .cell')
    bus = bench.source.buses.at(-1)!
    id = 'Bus/' + bus.number
  })

  test('finds a bus by name and sees it selected on the Network', async () => {
    // VS Code's own input box, from the Case panel's title bar, filters as it is typed in.
    await bench.panelAction('Filter Rows').click()
    await bench.page.locator('.quick-input-widget input').fill(bus.name)
    await bench.page.locator('.quick-input-widget input').press('Enter')
    await until(
      async () =>
        (await table.locator('tbody th[scope="row"]').count()) === 1 && (await row().count()) === 1,
      'the bus listed alone',
    )
    await row().locator('th[scope="row"] button').click()
    await until(() => bench.session.selection?.id === id, 'the bus selected')
    await until(
      async () =>
        (await network.evaluate<{ ids: string[] } | null>('gridkitSelection()'))?.ids.includes(id),
      'the Network shows it selected',
    )
  })

  test('changes its voltage level from the cell menu, and takes it back with undo', async () => {
    const changed = bus.params.kv + 1
    await menu(kv().locator('.cell'), 'Edit Field')
    await picker().locator('input').fill(String(changed))
    await picker().locator('input').press('Enter')
    await until(
      () =>
        JSON.parse(bench.document.getText()).buses.find(
          (each: { number: number }) => each.number === bus.number,
        ).params.kv === changed,
      'the edit reaches the case',
    )
    await until(
      async () => (await kv().innerText()).trim() === String(changed),
      'the table shows the new value',
    )
    await bench.settled()
    await bench.undo('undo takes it back')
    await until(
      async () => (await kv().innerText()).trim() === String(bus.params.kv),
      'the table shows the value again',
    )
  })

  test('faults it from its menu, runs GridKit, and reads its voltage drop in the Monitor', async () => {
    await menu(row().locator('th[scope="row"]'), 'Configure Fault')
    await until(
      () => bench.session.values.fault === true && bench.session.values.fault_bus === id,
      'the next run faults the bus',
    )
    await menu(row().locator('th[scope="row"]'), 'Plot Signal')
    await picker().locator('.monaco-list-row', { hasText: 'Bus.Vm' }).click()
    await until(
      () => bench.session.plots.some((plot) => plot.field === 'Vm' && plot.id === id),
      'its voltage plotted',
    )
    const simulation = await bench.show('simulation')
    await simulation.locator('[data-testid="field-tmax"]').fill('2')
    await until(() => bench.session.values.tmax === 2, 'a two-second run')
    const before = bench.session.run?.id
    await simulation.locator('[data-testid="simulation-start"]').click()
    await until(
      () =>
        bench.session.run?.id !== before &&
        !['preparing', 'running'].includes(bench.session.run?.state ?? 'preparing'),
      'the run ends',
      300_000,
    )
    const run = bench.session.run!
    assert.equal(run.state, 'complete', run.message)
    const fault = run.configuration!.addedFaults[0]!
    assert.equal(fault.bus, bus.number)
    const steady = await voltage(run.id, Math.max(0, fault.start - 0.05))
    const faulted = await voltage(run.id, fault.start + fault.duration / 2)
    assert.ok(faulted < steady - 0.1, `the faulted bus's voltage drops: ${steady} → ${faulted}`)
    const monitor = await bench.view('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    await bench.capture('workflow-fault')
  })

  test("colors the Network by the plotted voltage from the Monitor's menu, then removes it", async () => {
    // Undo showed the case's source; the Network comes back in front of it.
    network = await bench.open('network')
    const monitor = await bench.show('monitor')
    await visible(monitor, 'canvas[data-rendered=true]')
    const before = await frames(network)
    await menu(monitor.locator('canvas').first(), 'Map To')
    await picker().locator('.monaco-list-row', { hasText: 'Vertex Color' }).click()
    await picker().getByRole('button', { name: 'OK' }).click()
    await until(() => bench.session.bindings.vertexColor?.field === 'Vm', 'voltage mapped to color')
    await until(async () => (await frames(network)) > before, 'the Network repaints')
    await menu(monitor.locator('canvas').first(), 'Remove Mapping')
    await until(() => !bench.session.bindings.vertexColor, 'the mapping removed')
  })
})
