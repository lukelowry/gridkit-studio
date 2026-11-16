/** Solver-file runs against real GridKit, from Studio's side. GridKit's own output format is the
 *  contract suite's concern. */

import assert from 'node:assert/strict'

import { setup, suite, suiteSetup, test } from 'mocha'
import * as vscode from 'vscode'

import type { Field } from '../../src/shared/document.js'
import { type Bench, bench, folder, until } from './studio.js'

const VM = { table: 'Bus', field: 'Vm' }
/** Each monitor's type and field, without its element or range. */
const fields = (monitors: readonly Field[]) =>
  monitors.map(({ table, field }) => ({ table, field }))

suite('Runs', function () {
  // Include solver initialization and result ingestion on slower hosts.
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

  test('explains why a case that records nothing does not run', async () => {
    await host.recordOnly('Bus', [])
    await vscode.commands.executeCommand('gridkitStudio.runSimulation', host.solver)
    const [error] = host.takeErrors()
    assert.match(error!, /records nothing/)
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
    assert.deepEqual(fields(session.shown), [VM])
    assert.equal(session.transport.state.follow, false)
    assert.equal(session.transport.currentT(), results.domain[1])
    const { value } = await host.studio.client.worker.call('sample', {
      results: results.id,
      table: 'Bus',
      field: 'Vm',
      id: host.source.buses[0]!.number,
      at: results.domain[1],
    })
    assert.equal(typeof value, 'number')
  })

  test('shows what its solver file wrote last when it opens, and a new run plots what that records', async () => {
    await host.run()
    const written = host.session.results!
    assert.deepEqual(fields(host.session.shown), [VM])
    await vscode.commands.executeCommand('gridkitStudio.clearResults')
    assert.equal(host.studio.get(host.key)?.results, undefined)
    await vscode.window.showTextDocument(host.solver)
    const shown = await until(
      () => (host.session.results?.growing === false ? host.session.results : undefined),
      'the solver file shows its last results',
    )
    assert.equal(shown.frames, written.frames)
    assert.equal(shown.path, written.path)
    assert.equal(shown.solver, written.solver)
    // The monitors are what the shown results hold, until the next run, which lists and shows
    // what it recorded.
    await host.record('Bus', ['Va'])
    assert.deepEqual(fields(host.session.monitors), [VM])
    // A run starts only from its solver file's menu.
    const again = await host.run()
    assert.equal(again.state, 'complete', again.message)
    const va = { table: 'Bus', field: 'Va' }
    assert.deepEqual(fields(host.session.monitors), [va])
    assert.deepEqual(fields(host.session.shown), [va])
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
    // The span covers the solver file's whole run, however much has arrived.
    assert.equal(session.results?.span?.[1], 1000)
    session.transport.seek(0)
    assert.equal(session.transport.state.follow, false)
    await vscode.commands.executeCommand('gridkitStudio.goToEnd')
    assert.equal(session.transport.state.follow, true, 'Go to End follows the run again')
    await vscode.commands.executeCommand('gridkitStudio.stopSimulation')
    const run = await host.nextRun(before)
    assert.equal(run.state, 'cancelled')
    const results = await until(
      () => (session.results?.growing === false ? session.results : undefined),
      'what it wrote read through',
    )
    assert.ok(results.frames > 0 && results.domain[1] < 1000)
    assert.equal(results.span?.[1], 1000, 'a stopped run keeps its window')
    await vscode.commands.executeCommand('gridkitStudio.previousSample')
    assert.ok(session.transport.currentT() < results.domain[1], 'what it wrote plays')
  })

  test('explains once why GridKit could not finish, and runs again', async () => {
    await host.writeSolver({ tmax: 0.1, dt_monitor: 0.01, max_steps: 1, events: [] })
    const failed = await host.run()
    assert.equal(failed.state, 'failed')
    assert.ok(failed.message)
    const errors = host.takeErrors()
    assert.equal(errors.length, 1, errors.join('\n'))
    assert.ok(errors[0]!.includes(failed.message), errors[0])
    await host.writeSolver({ tmax: 0.1, dt_monitor: 0.01, events: [] })
    assert.equal((await host.run()).state, 'complete')
  })

  test('selects native only with an explicit path, and returns to WASM when cleared', async () => {
    const settings = vscode.workspace.getConfiguration('gridkitStudio')
    const global = vscode.ConfigurationTarget.Global
    const previous = settings.inspect<string>('gridkitPath')?.globalValue
    await settings.update('gridkitProgram', 'NoSuchSimulation', global)
    await settings.update('gridkitPath', folder().fsPath, global)
    try {
      const run = await host.run()
      assert.equal(run.state, 'failed')
      assert.equal(run.command, 'NoSuchSimulation IEEE39.solver.json')
      assert.ok(host.takeErrors().some((error) => error.includes(run.message!)))
      await settings.update('gridkitPath', '', global)
      const bundled = await host.run()
      assert.equal(bundled.state, 'complete', bundled.message)
      assert.equal(bundled.command, 'DynamicSimulation IEEE39.solver.json')
    } finally {
      await settings.update('gridkitPath', previous, global)
      await settings.update('gridkitProgram', undefined, global)
    }
  })
})
