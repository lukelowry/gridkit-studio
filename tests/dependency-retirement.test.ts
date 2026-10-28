import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { it } from 'vitest'

it('retires every split package and ships the exact native runtime with self-contained bundles', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.deepEqual(manifest.dependencies, { 'jsonc-parser': '3.3.1', latkit: '0.3.1' })
  assert.equal(manifest.pnpm.patchedDependencies, undefined)
  const retired = '@' + 'latkit/'
  assert.ok(!readFileSync('pnpm-lock.yaml', 'utf8').includes(retired))
  const visit = (folder: string) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, item.name)
      if (item.isDirectory()) visit(path)
      else if (/\.(ts|svelte|mjs)$/.test(item.name))
        assert.ok(!readFileSync(path, 'utf8').includes(retired), path)
    }
  }
  visit('src')
  visit('tests')
  for (const file of [
    'src/shared/schema.ts',
    'src/shared/coverage.ts',
    'src/shared/positions.ts',
    'src/webview/gpu.ts',
    'src/webview/rows.ts',
    'src/webview/samples.ts',
  ])
    assert.ok(!existsSync(file), file)
  assert.ok(!existsSync('patches') || readdirSync('patches').length === 0)
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
    assert.ok(
      Object.keys(metadata.inputs).every(
        (path) => !path.includes(retired) && !path.includes('@latkit+'),
      ),
    )
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
