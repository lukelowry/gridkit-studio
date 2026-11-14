import * as vscode from 'vscode'

import { Client } from '../../src/extension/client.js'
import { download } from '../../src/extension/download.js'
import { ExportFile } from '../../src/extension/exports.js'
import type { Sessions } from '../../src/extension/sessions.js'
import { workspaceAccess } from '../../src/extension/workspace.js'
import { readdir, readFile, rm, stat } from '../../src/platform/browser/files.js'
import { outputPath } from '../../src/platform/browser/host.js'
import { join } from '../../src/platform/browser/path.js'
import { FORMAT } from '../../src/results/store.js'

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
export async function run() {
  workspaceAccess()
  const extension = vscode.extensions.getExtension<{ studio: Sessions }>(
    'lukelowery.gridkit-studio',
  )!
  const { studio } = await extension.activate()
  const worker = studio.client.worker
  const folder = vscode.workspace.workspaceFolders![0]!.uri
  const model = vscode.Uri.joinPath(folder, 'IEEE39.case.json')
  const solver = vscode.Uri.joinPath(folder, 'browser.solver.json')
  const output = outputPath(vscode.Uri.joinPath(folder, 'browser.csv').toString())
  const revision = await worker.call('read', { uri: model.toString(), version: 1 })
  check(revision.version === 1, 'Case read in browser')
  const write = (tmax: number) =>
    vscode.workspace.fs.writeFile(
      solver,
      new TextEncoder().encode(
        JSON.stringify({
          system_model_file: 'IEEE39.case.json',
          output_file: 'browser.csv',
          tmax,
          dt_monitor: 0.001,
          events: [],
        }),
      ),
    )
  const request = {
    ...revision,
    run: 'browser',
    results: 'browser',
    solver: solver.toString(),
    output,
    tmax: 0.1,
    gridkit: { path: '', program: 'DynamicSimulation' },
  }
  for (let index = 0; index < 3; index++) {
    await write(0.1)
    const run = await worker.call('run', request)
    check(run.state === 'complete', `Browser run failed: ${run.message}`)
    check((await stat(output)).size > 100, 'Output persisted in browser storage')
    const csv = (await readFile(output, 'utf8')) as string
    check(/^t(?:ime)?[,\[]/.test(csv), 'Output has a CSV header: ' + csv.slice(0, 80))
    const target = `opfs:/gridkit/test-export-${index}.csv`
    await worker.call('export', { results: request.results, path: target })
    check((await readFile(target, 'utf8')) === csv, 'CSV export preserves exact bytes')
    if (index === 0) await download(target, 'browser-results.csv')
    await worker.call('close', { results: request.results })
    console.log(`Browser run ${index + 1}: simulation and CSV export passed`)
  }
  await write(1000)
  const controller = new AbortController()
  let live = false
  const heard = studio.client.event.event((event) => {
    if (event.kind === 'results' && event.progress.frames > 64) {
      live = true
      controller.abort()
    }
  })
  try {
    await worker.call('run', { ...request, tmax: 1000 }, controller.signal).catch((error) => {
      if (!controller.signal.aborted) throw error
    })
    check(live, 'Live results arrived before cancellation')
  } finally {
    heard.dispose()
  }
  for (let attempt = 0; (await worker.call('stats', {})).runs; attempt++) {
    check(attempt < 500, 'Cancellation stopped the solver')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  console.log('Browser live output and cancellation passed')
  await write(0.1)
  await vscode.commands.executeCommand('gridkitStudio.runSimulation', solver)
  const session = studio.get(model.toString())!
  check(session.run?.state === 'complete', 'Run command completed in a virtual workspace')
  const frames = session.results!.frames
  session.clear()
  await vscode.commands.executeCommand('gridkitStudio.showLastResults', solver)
  check(session.results?.frames === frames, 'Show Last Results reopened browser output')
  check(!studio.reporter.errors.length, studio.reporter.errors.join('\n'))
  const png = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(extension.extensionUri, 'assets/gridkit.png'),
  )
  const image = await ExportFile.choose(model, 'sample # image.png')
  check(image, 'Browser image export opened')
  await image.write(png.subarray(0, 100))
  await image.write(png.subarray(100))
  await image.close()
  await image.abort()
  console.log('Browser commands and image download passed')
  const store = 'opfs:/gridkit/test-stores/' + crypto.randomUUID()
  const make = () =>
    new Client(
      vscode.Uri.joinPath(extension.extensionUri, 'dist').toString(),
      () => ({ store, saved: [output], cacheBytes: 0 }),
      (error) => {
        throw error
      },
    )
  let client = make()
  try {
    await write(0.1)
    let read = await client.worker.call('read', { uri: model.toString(), version: 1 })
    check(
      (await client.worker.call('run', { ...request, ...read })).state === 'complete',
      'Fresh worker runs',
    )
    const kept = await client.worker.call('share', { results: request.results, as: 'kept' })
    await client.worker.call('close', { results: 'kept' })
    await client.worker.call('close', { results: request.results })
    const owner = (await readdir(join(store, FORMAT)))[0]!
    const saved = await readdir(join(store, FORMAT, owner))
    await client.dispose()
    client = make()
    read = await client.worker.call('read', { uri: model.toString(), version: 1 })
    const restored = await client.worker.call('open', {
      ...read,
      path: output,
      results: 'restored',
    })
    check(restored.frames === kept.frames, 'All cached frames restored')
    const owners = await readdir(join(store, FORMAT))
    check(owners.length === 1 && owners[0] !== owner, 'The old worker released its storage')
    const adopted = await readdir(join(store, FORMAT, owners[0]!))
    check(
      JSON.stringify(saved) === JSON.stringify(adopted),
      'Existing cache adopted without reparsing CSV',
    )
    console.log('Browser results survived a worker restart')
    await write(1000)
    let running = false
    const progress = client.event.event((event) => {
      if (event.kind === 'results' && event.progress.frames > 64) running = true
    })
    const pending = client.worker.call('run', { ...request, ...read, tmax: 1000 }).catch(() => {})
    for (let attempt = 0; !running; attempt++) {
      check(attempt < 500, 'Child solver started')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await client.dispose()
    await pending
    progress.dispose()
    const stopped = (await stat(output)).size
    await new Promise((resolve) => setTimeout(resolve, 100))
    check((await stat(output)).size === stopped, 'Terminating the parent also stopped its solver')
    client = make()
    await write(0.1)
    read = await client.worker.call('read', { uri: model.toString(), version: 1 })
    check(
      (await client.worker.call('run', { ...request, ...read }, AbortSignal.timeout(10_000)))
        .state === 'complete',
      'Output can be reused after parent termination',
    )
    console.log('Browser worker teardown released its solver and files')
  } finally {
    await client.dispose()
    await rm(store, { recursive: true, force: true })
  }
}
