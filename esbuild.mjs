import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build, context } from 'esbuild'
import svelte from 'esbuild-svelte'
const root = dirname(fileURLToPath(import.meta.url))
const output = resolve(root, 'dist')
if (dirname(output) !== root) throw new Error('Build output escaped the repository.')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  minify: !process.argv.includes('--watch'),
}
const builds = [
  {
    entryPoints: { extension: 'src/extension.ts', worker: 'src/worker.ts' },
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
      table: 'src/webview/table.ts',
      simulation: 'src/webview/simulation.ts',
      monitor: 'src/webview/monitor.ts',
    },
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'esm',
    splitting: true,
    target: 'es2022',
    conditions: ['browser'],
    plugins: [svelte({ compilerOptions: { css: 'external' } })],
  },
]
for (const options of builds) {
  const config = { ...common, ...options }
  if (process.argv.includes('--watch')) await (await context(config)).watch()
  else await build(config)
}
