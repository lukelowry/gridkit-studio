/** Sessions: what a case records, which its own `mon` lists say, the results file a session reads
 *  again when its case opens, the plots a new run keeps, and that a case nothing holds lets go of
 *  everything it held, in the extension and in the results worker. */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import { setup, suite, teardown, test } from 'mocha'
import * as vscode from 'vscode'

import type { Session } from '../../src/extension/session.js'
import type { Sessions } from '../../src/extension/sessions.js'
import { savedKey } from '../../src/shared/ids.js'
import type { Results } from '../../src/shared/messages.js'
import { plotsFor } from '../../src/shared/plots.js'
import { extension, folder, until } from './studio.js'

suite('Sessions', () => {
  let studio: Sessions
  let uri: vscode.Uri

  /** The case file at `at`, parsed. */
  const caseAt = async (at: vscode.Uri) =>
    JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(at)))

  /** A copy of IEEE39 of its own, followed. */
  async function copy(): Promise<vscode.Uri> {
    const made = vscode.Uri.joinPath(folder(), `recording-${randomUUID()}.case.json`)
    await vscode.workspace.fs.copy(vscode.Uri.joinPath(folder(), 'IEEE39.case.json'), made)
    await studio.open(made.toString())
    return made
  }

  /** A results file of the case at `at`: its first bus's voltage over a second. */
  async function samples(at: vscode.Uri, name = `results-${randomUUID()}.csv`) {
    const { buses } = (await caseAt(at)) as { buses: { name: string }[] }
    const csv = vscode.Uri.joinPath(folder(), name)
    await vscode.workspace.fs.writeFile(
      csv,
      new TextEncoder().encode(`time,Bus_${buses[0]!.name}_Vm\n0,1\n0.5,0.9\n1,1\n`),
    )
    return csv
  }

  /** The case's session let go of, as a reload does, and its case opened again: a session of its
   *  own, read anew from what the last one saved. An editor of it holds it, as one does after a
   *  reload, so a tab change that has the views follow the case in front meanwhile leaves it be. */
  async function reopen(session: Session) {
    session.release('active')
    session.release('document')
    assert.equal(studio.get(session.uri), undefined, 'Nothing holds the session, so it closes')
    studio.hold(session.uri, 'document')
    reopened.push(session.uri)
    return studio.open(uri.toString())
  }
  /** The cases tests reopened, each let go of as its test ends, as its editor closing would. */
  const reopened: string[] = []
  teardown(() => {
    for (const uri of reopened.splice(0)) studio.release(uri, 'document')
  })

  setup(async () => {
    studio = (await extension().activate()).studio
    uri = await copy()
  })

  test('a case records what its own lists name', async () => {
    const source = (await caseAt(uri)) as {
      buses: { mon?: string[] }[]
      devices: { class: string; mon?: string[] }[]
    }
    const listed: Record<string, Record<string, number>> = {}
    for (const { type, mon = [] } of [
      ...source.buses.map(({ mon }) => ({ type: 'Bus', mon })),
      ...source.devices.map(({ class: type, mon }) => ({ type, mon })),
    ])
      for (const name of mon) (listed[type] ??= {})[name] = (listed[type]?.[name] ?? 0) + 1
    assert.deepEqual((await studio.files.read(uri.toString())).recording.listed, listed)
  })

  test('a new run keeps the plots it recorded, else plots its first signal', () => {
    const results = {
      outputs: [
        { table: 'Bus', field: 'Va', ids: [1] },
        { table: 'Bus', field: 'Vm', ids: [1] },
      ],
    } as unknown as Results
    const vm = { from: 'Bus', field: 'Vm' }
    assert.deepEqual(plotsFor(results, [vm, { from: 'Bus', field: 'Pg' }]), [vm])
    assert.deepEqual(plotsFor(results, [{ from: 'Gen', field: 'Pg' }]), [
      { from: 'Bus', field: 'Va' },
    ])
    assert.deepEqual(plotsFor({ outputs: [] } as unknown as Results, [vm]), [])
  })

  test('forgets cases deleted while it was closed, and keeps those that exist', async () => {
    const session = studio.current()
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
    const session = studio.current()
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
    const session = studio.current()
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
    // What a run of the solver file wrote, read from where the solver file wrote it then.
    const before = await samples(uri, `${name}.csv`)
    await session.load(before.fsPath, solver.fsPath)
    // The solver file writes elsewhere now, and that file is the one read again.
    await vscode.workspace.fs.delete(before)
    const now = vscode.Uri.joinPath(folder(), 'output', `${name}.csv`)
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder(), 'output'))
    await vscode.workspace.fs.copy(await samples(uri), now)
    const restored = await reopen(session)
    await until(() => restored.results?.path === now.fsPath, 'the file the solver file writes')
    assert.equal(restored.results!.solver, solver.fsPath)
    await vscode.workspace.fs.delete(solver)
  })

  test('lets go of every case nothing holds, here and in the results worker, where they rest', async () => {
    const stats = async () => (await studio.client.stats()).results
    const held = (await stats()) ?? { files: 0, resting: 0, cases: 0 }
    // Cases followed one after another, each showing results, each closed as the next is followed.
    const visited: Session[] = []
    for (let n = 0; n < 3; n++) {
      const opened = await copy()
      const session = studio.current()
      await session.load((await samples(opened)).fsPath)
      visited.push(session)
      session.release('document')
    }
    // Only the case followed now holds anything: each before it closed as the next was followed.
    const [last] = visited.slice(-1)
    for (const session of visited.slice(0, -1))
      assert.equal(studio.get(session.uri), undefined, 'A case nothing holds closes')
    await until(async () => (await stats())!.files === held.files + 1, 'one results file held')
    // What the cases before showed may rest in the worker, with its case, under the budget, to open
    // again without reading anything: a case is read for the results held, and each that rests.
    const now = (await stats())!
    assert.ok(now.resting - held.resting <= 2, 'Only results let go of rest')
    assert.equal(
      now.cases,
      held.cases + 1 + (now.resting - held.resting),
      'The worker reads a case for the results held, and for each that rests',
    )
    // The last lets go once another case is followed.
    await studio.open(uri.toString())
    assert.equal(studio.get(last!.uri), undefined)
    await until(async () => (await stats())!.files === held.files, 'no results file of theirs held')
  })
})
