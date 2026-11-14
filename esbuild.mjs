/** Bundle the extension and its worker for Node, and the webviews for the browser, into dist/.
 *  `--watch` rebuilds on change, unminified. */

import { cp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build, context } from 'esbuild'
import svelte from 'esbuild-svelte'

import { browserPlatform } from './scripts/platform.mjs'
import { copySolver } from './scripts/solver.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const output = resolve(root, 'dist')
const watch = process.argv.includes('--watch')
const require = createRequire(import.meta.url)
const packageRoot = resolve(dirname(require.resolve('latkit')), '..')

await rm(output, { recursive: true, force: true })
await mkdir(resolve(output, 'webview'), { recursive: true })
await mkdir(resolve(output, 'licenses'), { recursive: true })
const common = {
  absWorkingDir: root,
  bundle: true,
  mainFields: ['module', 'main'],
  sourcemap: true,
  metafile: true,
  logLevel: 'warning',
  minify: !watch,
}
const builds = [
  {
    entryPoints: ['src/extension/index.ts'],
    outfile: 'dist/browser/extension.cjs',
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    external: ['vscode'],
    plugins: [browserPlatform],
  },
  {
    entryPoints: { worker: 'src/workers/worker.ts', solver: 'src/workers/solver.ts' },
    outdir: 'dist/browser',
    outExtension: { '.js': '.mjs' },
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    plugins: [browserPlatform],
    define: { 'import.meta.url': 'self.location.href' },
    banner: { js: '(async () => {' },
    footer: { js: '})().catch(error => { setTimeout(() => { throw error }) });' },
  },
  {
    entryPoints: ['src/extension/index.ts'],
    outfile: 'dist/extension.cjs',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
  },
  {
    entryPoints: { worker: 'src/workers/worker.ts', solver: 'src/workers/solver.ts' },
    outdir: 'dist',
    outExtension: { '.js': '.mjs' },
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);",
    },
  },
  {
    entryPoints: {
      network: 'src/webview/network.ts',
      case: 'src/webview/case.ts',
      monitor: 'src/webview/monitor.ts',
      export: 'src/webview/export.ts',
      download: 'src/webview/download.ts',
    },
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'esm',
    splitting: true,
    target: 'es2022',
    // Svelte's production build, without its checks for development.
    conditions: ['browser', watch ? 'development' : 'production'],
    plugins: [svelte({ compilerOptions: { css: 'external' } })],
  },
]
await Promise.all([
  copySolver(resolve(output, 'solver')),
  cp(
    resolve(dirname(require.resolve('@noble/hashes/sha2.js')), 'LICENSE'),
    resolve(output, 'licenses/noble-hashes.md'),
  ),
  cp(
    resolve(dirname(require.resolve('vscode-uri')), '../../LICENSE.md'),
    resolve(output, 'licenses/vscode-uri.md'),
  ),
  cp(require.resolve('latkit/wasm'), resolve(output, 'webview/latkit.wasm')),
  cp(require.resolve('latkit/worker'), resolve(output, 'webview/latkit-worker.js')),
  cp(resolve(root, 'assets/maps'), resolve(output, 'webview/maps'), { recursive: true }),
  cp(resolve(packageRoot, 'NOTICES.md'), resolve(output, 'licenses/latkit-NOTICES.md')),
  cp(resolve(packageRoot, 'THIRD_PARTY.md'), resolve(output, 'licenses/latkit-THIRD_PARTY.md')),
])
for (const options of builds) {
  const config = { ...common, ...options }
  if (watch) await (await context(config)).watch()
  else {
    const result = await build(config)
    // The VSIX ships no node_modules: every bundle holds all it imports but VS Code and Node.
    for (const [file, bundle] of Object.entries(result.metafile.outputs))
      for (const { path, external } of bundle.imports)
        if (external && path !== 'vscode' && !path.startsWith('node:'))
          throw new Error(`${file} imports ${path}, which is not bundled.`)
  }
}
