/** Bundle the extension and its two workers for Node, and the webviews for the browser, into dist/.
 *  `--watch` rebuilds on change, unminified. */

import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build, context } from 'esbuild'
import svelte from 'esbuild-svelte'

const root = dirname(fileURLToPath(import.meta.url))
const output = resolve(root, 'dist')
const watch = process.argv.includes('--watch')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'warning',
  minify: !watch,
  // Minified, a defect's stack in the log still names the functions it passed through.
  keepNames: true,
}
const builds = [
  {
    entryPoints: {
      extension: 'src/extension/index.ts',
      cases: 'src/workers/cases.ts',
      results: 'src/workers/results.ts',
    },
    outdir: 'dist',
    outExtension: { '.js': '.cjs' },
    platform: 'node',
    mainFields: ['module', 'main'],
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
  },
  {
    entryPoints: {
      canvas: 'src/webview/canvas.ts',
      case: 'src/webview/case.ts',
      monitor: 'src/webview/monitor.ts',
      export: 'src/webview/export.ts',
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
for (const options of builds) {
  const config = { ...common, ...options }
  if (watch) await (await context(config)).watch()
  else await build(config)
}

await cp('assets/maps', 'dist/webview/maps', { recursive: true })
