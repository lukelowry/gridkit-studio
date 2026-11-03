import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { it } from 'vitest'

it('ships the exact native runtime with self-contained bundles', () => {
  execFileSync(process.execPath, ['esbuild.mjs'], { stdio: 'pipe', windowsHide: true })
  const require = createRequire(import.meta.url)
  for (const [name, asset] of [
    ['latkit/wasm', 'latkit.wasm'],
    ['latkit/worker', 'latkit-worker.js'],
  ])
    assert.deepEqual(
      readFileSync(require.resolve(name!)),
      readFileSync(join('dist/webview', asset!)),
    )
  for (const file of [
    'extension.cjs',
    'cases.mjs',
    'results.mjs',
    'licenses/latkit-NOTICES.md',
    'licenses/latkit-THIRD_PARTY.md',
  ])
    assert.ok(readFileSync(join('dist', file)).byteLength > 0)
  for (const name of readdirSync('dist').filter((name) => name.startsWith('metafile-'))) {
    const metadata = JSON.parse(readFileSync(join('dist', name), 'utf8'))
    for (const output of Object.values(metadata.outputs) as {
      imports: { path: string; external?: boolean }[]
    }[])
      assert.ok(
        output.imports.every(
          (item) => !item.external || item.path === 'vscode' || item.path.startsWith('node:'),
        ),
        'All runtime dependencies are bundled',
      )
  }
}, 30_000)
