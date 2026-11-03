/** Playing results from the commands the status bar and the keys run: a results file of the case's,
 *  stepped through, played, paused and sought. */

import assert from 'node:assert/strict'

import { suite, suiteSetup, test } from 'mocha'
import * as vscode from 'vscode'

import { type Bench, bench, folder, until } from './studio.js'

suite('Playback', () => {
  let host: Bench

  suiteSetup(async () => {
    host = await bench()
  })

  test('steps, plays, pauses, and goes to a time and to the end from its commands', async () => {
    // A second of every bus's voltage, 101 samples.
    const csv = vscode.Uri.joinPath(folder(), 'playback.csv')
    const buses = host.source.buses
    const rows = Array.from(
      { length: 101 },
      (_, i) => [i / 100, ...buses.map((_, k) => 1 + 0.1 * Math.sin(i / 10 + k))].join(',') + '\n',
    )
    await vscode.workspace.fs.writeFile(
      csv,
      new TextEncoder().encode(
        ['time', ...buses.map((bus) => `Bus_${bus.name}_Vm`)].join(',') + '\n' + rows.join(''),
      ),
    )
    const { session } = host
    await session.load(csv.fsPath)
    await until(() => session.results?.growing === false, 'the file read')
    const { transport } = session
    /** Where the playhead is once `command` ran, to a sample's precision. */
    const go = async (command: string, ...args: unknown[]) => {
      await vscode.commands.executeCommand('gridkitStudio.' + command, ...args)
      return Math.round(transport.currentT() * 100) / 100
    }
    assert.equal(await go('goToTime', 0.5), 0.5)
    assert.equal(await go('nextSample'), 0.51)
    assert.equal(await go('previousSample'), 0.5)
    await go('playPause')
    assert.equal(transport.state.status, 'playing')
    await until(() => transport.currentT() > 0.5, 'the playhead moves')
    await go('playPause')
    assert.equal(transport.state.status, 'paused')
    assert.equal(await go('goToEnd'), 1)
    host.command('gridkitStudio.clearResults')
    await until(() => !session.results, 'the results go')
  })
})
