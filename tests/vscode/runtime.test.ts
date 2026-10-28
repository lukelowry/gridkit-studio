/** Execute the packaged assets under VS Code's actual webview CSP. */
import assert from 'node:assert/strict'

import { suite, test } from 'mocha'
import type { Route } from 'playwright-core'
import * as vscode from 'vscode'

import { testHost, until } from './harness.js'

suite('Bundled native runtime', () => {
  test('loads local WASM, border maps, and the standalone Blob worker under the webview CSP', async () => {
    const bench = await testHost()
    const context = bench.page.context()
    const settings = vscode.workspace.getConfiguration('gridkitStudio')
    const offline = async (route: Route) => {
      const host = new URL(route.request().url()).hostname
      if (host.endsWith('.vscode-cdn.net') || host.endsWith('.vscode-webview.net'))
        await route.continue()
      else await route.abort('internetdisconnected')
    }
    await context.route('https://**/*', offline)
    try {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      const { network } = await bench.openCase('cases/WECC240.case.json')
      const result = await network.evaluate<{
        csp: string
        ready: boolean
        maps: number[]
        external: string[]
      }>(`(async () => {
      const asset = name => document.querySelector('meta[name="' + name + '"]').content
      const wasmUrl = asset('latkit-wasm')
      const workerUrl = asset('latkit-worker')
      const base = asset('latkit-assets')
      const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content
      const [wasm, source, ...maps] = await Promise.all([
        fetch(wasmUrl).then(response => {
          if (!response.ok) throw new Error('Packaged WASM failed')
          return response.arrayBuffer()
        }),
        fetch(workerUrl).then(response => {
          if (!response.ok) throw new Error('Packaged worker failed')
          return response.text()
        }),
        ...['countries', 'provinces', 'coastline'].map(name =>
          fetch(new URL('maps/' + name + '.geojson.gz', base)).then(async response => {
            if (!response.ok) throw new Error('Packaged borders failed')
            return (await response.arrayBuffer()).byteLength
          }))
      ])
      const module = await WebAssembly.compile(wasm)
      const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      const worker = new Worker(blob)
      let timer
      try {
        const ready = await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Standalone worker did not initialize')), 15000)
          worker.onmessage = event => event.data.ready ? resolve(true) : reject(new Error(JSON.stringify(event.data)))
          worker.onerror = event => reject(new Error(event.message))
          worker.postMessage(module)
        })
        const packaged = new URL(base)
        const external = performance.getEntriesByType('resource')
          .map(entry => entry.name)
          .filter(name => {
            if (!/^https?:/.test(name)) return false
            const url = new URL(name)
            return url.origin !== packaged.origin ||
              !decodeURIComponent(url.pathname).startsWith(decodeURIComponent(packaged.pathname))
          })
        return { csp, ready, maps, external }
      } finally {
        clearTimeout(timer)
        worker.terminate()
        URL.revokeObjectURL(blob)
      }
    })()`)
      assert.equal(result.ready, true)
      assert.ok(result.csp.includes("'wasm-unsafe-eval'"))
      assert.ok(result.csp.includes('worker-src blob:'))
      assert.ok(result.maps.every((bytes) => bytes > 0))
      assert.deepEqual(result.external, [], 'Runtime and fonts must use packaged assets')
      const camera = await network.evaluate<{ center: [number, number]; zoom: number }>(
        'gridkitSelection().camera',
      )
      assert.ok(camera.zoom > 1, 'cold opening must fit the case, not the whole world')
      assert.ok(camera.center[0] < -90 && camera.center[0] > -140)
      for (const source of ['none', 'borders']) {
        const rows = await network.evaluate<number>('gridkitStats().rows')
        await settings.update('network.map.source', source, vscode.ConfigurationTarget.Global)
        await until(
          () =>
            network.evaluate<boolean>(`gridkitStats().rows !== ${rows} && gridkitStats().complete`),
          'the offline map changes without reframing the case',
        )
        assert.deepEqual(await network.evaluate('gridkitSelection().camera'), camera)
      }
    } finally {
      await context.unroute('https://**/*', offline)
      await settings.update('network.map.source', undefined, vscode.ConfigurationTarget.Global)
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    }
  })
})
