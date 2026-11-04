/** Runs of a solver file against real GridKit, as Studio holds them: what the case records, the
 *  results read through, a live run followed and stopped, and a run that fails said once. What
 *  GridKit writes and reads back is the contract suite's. */

import assert from 'node:assert/strict'

import { setup, suite, suiteSetup, test } from 'mocha'
import * as vscode from 'vscode'

import { type Bench, bench, folder, until } from './studio.js'

suite('Runs', function () {
  // A run lasts as long as GridKit does, a container's start included.
  this.timeout(120_000)
  let host: Bench

  suiteSetup(async function () {
    host = await bench()
    if (!(await host.gridkit())) this.skip()
  })
  setup(async () => {
    await host.reset()
    await host.recordOnly('Bus', ['Vm'])
    await host.writeSolver({ tmax: 0.5, dt_monitor: 0.01, events: [] })
  })

  test('says why a case that records nothing runs nothing', async () => {
    await host.recordOnly('Bus', [])
    host.command('gridkitStudio.runSimulation', host.solver)
    const [said] = await until(() => {
      const said = host.said()
      return said.length ? said : undefined
    }, 'why nothing runs')
    assert.match(said!, /records nothing/)
    assert.equal(host.session.run, undefined)
  })

  test('runs its solver file, and reads what the case records to the end', async () => {
    const run = await host.run()
    assert.equal(run.state, 'complete', run.message)
    assert.equal(run.command, 'DynamicSimulation IEEE39.solver.json')
    const { session } = host
    const results = await until(
      () => (session.results?.growing === false ? session.results : undefined),
      'the results read through',
    )
    assert.equal(results.path, vscode.Uri.joinPath(folder(), 'output', 'IEEE39.csv').fsPath)
    assert.equal(results.solver, host.solver.fsPath)
    assert.deepEqual(
      results.outputs.map(({ table, field, ids }) => [table, field, ids.length]),
      [['Bus', 'Vm', host.source.buses.length]],
    )
    assert.ok(Math.abs(results.domain[1] - 0.5) < 1e-9, 'the run reaches its end')
    assert.deepEqual(session.plots, [{ from: 'Bus', field: 'Vm' }])
    // The playhead rests at the end of the run, which the views read from the samples it wrote.
    assert.equal(session.transport.state.follow, false)
    assert.equal(session.transport.currentT(), results.domain[1])
    const { value } = await host.studio.client.results.call('sample', {
      results: results.id,
      table: 'Bus',
      field: 'Vm',
      id: host.source.buses[0]!.number,
      at: results.domain[1],
    })
    assert.equal(typeof value, 'number')
  })

  test('shows what its solver file wrote last, and runs it again', async () => {
    await host.run()
    const written = host.session.results!
    host.command('gridkitStudio.clearResults')
    await until(() => !host.session.results, 'the results go')
    host.command('gridkitStudio.showLastResults', host.solver)
    await until(
      () => host.session.results?.frames === written.frames,
      'the last results show again',
    )
    assert.equal(host.session.results!.path, written.path)
    const again = await host.run('gridkitStudio.runSimulationAgain')
    assert.equal(again.state, 'complete', again.message)
  })

  test('keeps its plots until the next run, which plots what it recorded', async () => {
    await host.run()
    await host.record('Bus', ['Va'])
    assert.deepEqual(host.session.plots, [{ from: 'Bus', field: 'Vm' }])
    await host.run()
    assert.deepEqual(host.session.plots, [{ from: 'Bus', field: 'Va' }])
  })

  test('follows a live run, and a stop keeps what it wrote', async () => {
    await host.writeSolver({ tmax: 1000, dt_monitor: 0.001, events: [] })
    const before = host.session.run?.id
    host.command('gridkitStudio.runSimulation', host.solver)
    const { session } = host
    await until(
      () => session.run?.id !== before && session.live && (session.results?.frames ?? 0) > 64,
      'live samples arrive',
      60_000,
    )
    assert.equal(session.run?.state, 'running')
    assert.equal(session.transport.state.follow, true)
    // The views show the solver file's whole run, whatever has arrived of it.
    assert.equal(session.results?.span?.[1], 1000)
    session.transport.seek(0)
    assert.equal(session.transport.state.follow, false)
    host.command('gridkitStudio.goToEnd')
    await until(() => session.transport.state.follow, 'Go to End follows the run again')
    host.command('gridkitStudio.stopSimulation')
    const run = await host.ran(before)
    assert.equal(run.state, 'cancelled')
    const results = await until(
      () => (session.results?.growing === false ? session.results : undefined),
      'what it wrote read through',
    )
    assert.ok(results.frames > 0 && results.domain[1] < 1000)
    assert.equal(results.span?.[1], 1000, 'a stopped run keeps its window')
    host.command('gridkitStudio.previousSample')
    await until(() => session.transport.currentT() < results.domain[1], 'what it wrote plays')
  })

  test('says once why GridKit could not finish, and runs again', async () => {
    await host.writeSolver({ tmax: 0.1, dt_monitor: 0.01, max_steps: 1, events: [] })
    const failed = await host.run()
    assert.equal(failed.state, 'failed')
    assert.ok(failed.message)
    const said = host.said()
    assert.equal(said.length, 1, said.join('\n'))
    assert.ok(said[0]!.includes(failed.message), said[0])
    await host.writeSolver({ tmax: 0.1, dt_monitor: 0.01, events: [] })
    assert.equal((await host.run()).state, 'complete')
  })

  test('starts the program GridKit Program names', async () => {
    const settings = vscode.workspace.getConfiguration('gridkitStudio')
    const global = vscode.ConfigurationTarget.Global
    // A program no install or image has: the run, under its name, fails wherever GridKit runs.
    await settings.update('gridkitProgram', 'NoSuchSimulation', global)
    try {
      const run = await host.run()
      assert.equal(run.state, 'failed')
      assert.equal(run.command, 'NoSuchSimulation IEEE39.solver.json')
      assert.ok(host.said().some((said) => said.includes(run.message!)))
    } finally {
      await settings.update('gridkitProgram', undefined, global)
    }
  })
})
