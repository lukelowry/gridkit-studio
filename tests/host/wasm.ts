/** Repeated WASM worker creation and cancellation inside Electron's Node runtime. */
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as vscode from 'vscode'

import { Client } from '../../src/extension/client.js'
import { launchWasm } from '../../src/gridkit/wasm.js'
import type { RunRequest } from '../../src/shared/simulation.js'

export async function run() {
  const root = process.env.GRIDKIT_TEST_ROOT!
  await mkdir(join(root, 'output'), { recursive: true })
  const folder = await mkdtemp(join(root, 'output', 'wasm-host-'))
  const model = join(folder, 'IEEE39.case.json')
  await copyFile(join(root, 'cases', 'IEEE39.case.json'), model)
  const solver = join(folder, 'IEEE39.solver.json')
  const output = join(folder, 'out.csv')
  const dist = join(
    vscode.extensions.getExtension('lukelowery.gridkit-studio')!.extensionPath,
    'dist',
  )
  const assets = {
    worker: join(dist, 'solver.mjs'),
    module: join(dist, 'solver', 'DynamicSimulation.mjs'),
    wasm: join(dist, 'solver', 'DynamicSimulation.wasm'),
  }
  const request: RunRequest = {
    uri: pathToFileURL(model).href,
    version: 1,
    run: 'host',
    results: 'host',
    solver,
    output,
    tmax: 0.05,
    gridkit: { program: 'DynamicSimulation', path: '' },
  }
  for (let i = 0; i < 8; i++) {
    const controller = new AbortController()
    await writeFile(
      solver,
      JSON.stringify({
        system_model_file: 'IEEE39.case.json',
        output_file: 'out.csv',
        tmax: i % 2 ? 1000 : 0.05,
        dt_monitor: 0.001,
        events: [],
      }),
    )
    const execution = await launchWasm(request, assets, {
      signal: controller.signal,
      log: () => {},
    })
    if (i % 2) {
      controller.abort(new Error('Stopped by the test'))
      await assert.rejects(execution.done, /Stopped by the test/)
    } else await execution.done
    console.log(`WASM host run ${i + 1} finished`)
  }
  await writeFile(
    solver,
    JSON.stringify({
      system_model_file: 'IEEE39.case.json',
      output_file: 'out.csv',
      tmax: 0.05,
      dt_monitor: 0.001,
      events: [],
    }),
  )
  const client = new Client(
    dist,
    () => ({ store: join(folder, 'store'), saved: [], cacheBytes: 0 }),
    (error) => {
      throw error
    },
  )
  try {
    const revision = await client.worker.call('read', { uri: request.uri, version: 1 })
    for (let i = 0; i < 8; i++) {
      const result = await client.worker.call('run', {
        ...request,
        ...revision,
        run: String(i),
        results: String(i),
      })
      assert.equal(result.state, 'complete', result.message)
      await client.worker.call('close', { results: String(i) })
      console.log(`WASM nested run ${i + 1} finished`)
    }
  } finally {
    await client.dispose()
  }
}
