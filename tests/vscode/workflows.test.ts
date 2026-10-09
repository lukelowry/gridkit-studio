/** What a user does with a case, end to end against real GridKit: find a bus by name and see it on
 *  the Network, change it and take the change back, record its voltage, fault it in the solver file
 *  and run that, read its voltage drop in the Monitor, and color the Network by that voltage. Each
 *  step goes through the views, the menus and the files. */

import assert from 'node:assert/strict'

import type { RowsBlock } from '@latkit/model'
import { suite, suiteSetup, test } from 'mocha'
import type { Frame } from 'playwright-core'

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
  /** The bus's row in the Case panel. */
  const row = () =>
    table
      .locator('tbody tr')
      .filter({ has: table.locator('th[scope="row"]', { hasText: new RegExp(`^${bus.number}$`) }) })
  const kv = () => row().locator(`td[data-vscode-context*='"field":"params.kv"']`)
  /** The bus's recorded voltage at time `t` of `results`. */
  async function voltage(results: string, t: number): Promise<number> {
    const blocks = await bench.studio.client.call('query', {
      uri: bench.key,
      version: (await bench.current()).version,
      results,
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
    await bench.caseType('Bus')
    await visible(table, 'tbody .cell')
    bus = bench.source.buses.at(-1)!
    id = 'Bus/' + bus.number
  })

  test('finds a bus by name and sees it selected on the Network', async () => {
    // VS Code's own input box, from the Case panel's title bar, filters as it is typed in.
    await bench.title('case', 'Filter Rows')
    await bench.answer(bus.name)
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
    await bench.menu(kv().locator('.cell'), 'Edit Field')
    await bench.answer(String(changed))
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

  test('records its voltage, faults it in the solver file, runs that, and reads the drop in the Monitor', async () => {
    await bench.toggleSignal('Bus', 'Vm')
    await bench.menu(row().locator('th[scope="row"]'), 'Plot Signal')
    await bench.pick('Bus.Vm')
    await until(
      () => bench.session.plots.some((plot) => plot.field === 'Vm' && plot.id === id),
      'its voltage plotted',
    )
    // The fault GridKit's events name: the case's own fault on this bus, by its place among them.
    const element = (bench.source.devices as { class?: string; ports?: { bus?: number } }[])
      .filter((device) => device.class === 'BusFault')
      .findIndex((device) => device.ports?.bus === bus.number)
    assert.ok(element >= 0, 'the case has a fault on the bus')
    await bench.writeSolver({
      tmax: 2,
      dt_monitor: 0.01,
      events: [
        { time: 1, type: 'fault_on', element_id: element },
        { time: 1.1, type: 'fault_off', element_id: element },
      ],
    })
    const before = bench.session.run?.id
    bench.run()
    await until(
      () => bench.session.run?.id !== before && bench.session.run?.state !== 'running',
      'the run ends',
      300_000,
    )
    const run = bench.session.run!
    assert.equal(run.state, 'complete', run.message)
    const steady = await voltage(run.results!.id, 0.95)
    const faulted = await voltage(run.results!.id, 1.05)
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
    await bench.menu(monitor.locator('canvas').first(), 'Map To')
    await bench.check(['Vertex Color'])
    await until(() => bench.session.bindings.vertexColor?.field === 'Vm', 'voltage mapped to color')
    await until(async () => (await frames(network)) > before, 'the Network repaints')
    await bench.menu(monitor.locator('canvas').first(), 'Remove Mapping')
    await until(() => !bench.session.bindings.vertexColor, 'the mapping removed')
  })
})
