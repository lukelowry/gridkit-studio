/** Session restore on reopen, and release of everything a closed session owned in the extension and
 *  the worker. */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import { setup, suite, teardown, test } from 'mocha'
import * as vscode from 'vscode'

import type { Session } from '../../src/extension/session.js'
import type { Studio } from '../../src/extension/studio.js'
import { savedKey } from '../../src/shared/ids.js'
import { extension, folder, until } from './studio.js'

suite('Sessions', () => {
  let studio: Studio
  let uri: vscode.Uri

  const caseAt = async (at: vscode.Uri) =>
    JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(at)))

  async function copy(): Promise<vscode.Uri> {
    const made = vscode.Uri.joinPath(folder(), `recording-${randomUUID()}.case.json`)
    await vscode.workspace.fs.copy(vscode.Uri.joinPath(folder(), 'IEEE39.case.json'), made)
    await studio.open(made.toString())
    return made
  }

  /** Writes a results file for the case at `at`: its first bus's voltage over one second. */
  async function samples(at: vscode.Uri, name = `results-${randomUUID()}.csv`) {
    const { buses } = (await caseAt(at)) as { buses: { name: string }[] }
    const csv = vscode.Uri.joinPath(folder(), name)
    await vscode.workspace.fs.writeFile(
      csv,
      new TextEncoder().encode(`time,Bus_${buses[0]!.name}_Vm\n0,1\n0.5,0.9\n1,1\n`),
    )
    return csv
  }

  /** Closes the session, as a reload does, and opens the case again from its saved state. A
   *  document hold keeps it open, as an editor would, so tab changes cannot close it meanwhile. */
  async function reopen(session: Session) {
    session.release('active')
    session.release('document')
    assert.equal(studio.get(session.uri), undefined, 'Nothing holds the session, so it closes')
    studio.hold(session.uri, 'document')
    reopened.push(session.uri)
    return studio.open(uri.toString())
  }
  /** Cases reopened by a test; their document holds are released when it ends. */
  const reopened: string[] = []
  teardown(() => {
    for (const uri of reopened.splice(0)) studio.release(uri, 'document')
  })

  setup(async () => {
    studio = (await extension().activate()).studio
    uri = await copy()
  })

  test('forgets cases deleted while it was closed, and keeps those that exist', async () => {
    const session = studio.get(studio.active!)!
    session.setPlots([])
    const gone = savedKey(
      vscode.Uri.joinPath(folder(), `gone-${randomUUID()}.case.json`).toString(),
    )
    await studio.context.workspaceState.update(gone, { plots: [] })
    await studio.prune()
    const keys = studio.context.workspaceState.keys()
    assert.ok(!keys.includes(gone), 'A deleted case keeps no saved state')
    assert.ok(keys.includes(savedKey(session.uri)), 'An existing case keeps its saved state')
  })

  test('reads the results file it showed again when the case opens, and forgets one gone', async () => {
    const session = studio.get(studio.active!)!
    const csv = await samples(uri)
    await session.load(csv.fsPath)
    const restored = await reopen(session)
    await until(() => restored.results?.path === csv.fsPath, 'the file read again')
    assert.equal(restored.results!.frames, 3)
    await vscode.workspace.fs.delete(csv)
    const forgetting = await reopen(restored)
    await until(
      () =>
        !studio.context.workspaceState.get<{ results?: unknown }>(savedKey(session.uri))?.results,
      'a file that is gone is forgotten',
    )
    assert.equal(forgetting.results, undefined)
  })

  test('reads a simulation again from where its solver file writes now', async () => {
    const session = studio.get(studio.active!)!
    const name = randomUUID()
    const solver = vscode.Uri.joinPath(folder(), `${name}.solver.json`)
    const solverText = JSON.stringify({
      system_model_file: basename(uri.path),
      output_file: `output/${name}.csv`,
      dt_monitor: 0.5,
      tmax: 1,
      events: [],
    })
    await vscode.workspace.fs.writeFile(solver, new TextEncoder().encode(solverText))
    const before = await samples(uri, `${name}.csv`)
    await session.load(before.fsPath, solver.fsPath)
    // The solver file now writes elsewhere, and the restore reads from there.
    await vscode.workspace.fs.delete(before)
    const now = vscode.Uri.joinPath(folder(), 'output', `${name}.csv`)
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder(), 'output'))
    await vscode.workspace.fs.copy(await samples(uri), now)
    const restored = await reopen(session)
    await until(() => restored.results?.path === now.fsPath, 'the file the solver file writes')
    assert.equal(restored.results!.solver, solver.fsPath)
    await vscode.workspace.fs.delete(solver)
  })

  test('closes every released case, here and in the worker, and keeps their results idle', async () => {
    const stats = () => studio.client.stats()
    const baseline = (await stats()) ?? { cases: 0, files: 0, idle: 0 }
    // Activate cases in turn, each showing results; each closes when the next becomes active.
    const visited: Session[] = []
    for (let n = 0; n < 3; n++) {
      const opened = await copy()
      const session = studio.get(studio.active!)!
      await session.load((await samples(opened)).fsPath)
      visited.push(session)
      session.release('document')
    }
    const [last] = visited.slice(-1)
    for (const session of visited.slice(0, -1))
      assert.equal(studio.get(session.uri), undefined, 'A case nothing holds closes')
    await until(async () => (await stats())!.files === baseline.files + 1, 'one results file held')
    // Released results may stay cached in the worker within its budget, but it follows none of
    // their files.
    const now = (await stats())!
    assert.ok(now.idle - baseline.idle <= 2, 'Only released results stay idle')
    assert.ok(now.cases <= baseline.cases + 1, 'The worker follows only the cases held')
    // The last case closes once another becomes active.
    await studio.open(uri.toString())
    assert.equal(studio.get(last!.uri), undefined)
    await until(
      async () => (await stats())!.files === baseline.files,
      'no results file of theirs held',
    )
  })
})
