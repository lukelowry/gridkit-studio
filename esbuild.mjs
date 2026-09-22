import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build, context } from 'esbuild'
import svelte from 'esbuild-svelte'

const browserRoot = 'dist/network'
await mkdir(browserRoot, { recursive: true })
await cp(
  join(dirname(fileURLToPath(import.meta.resolve('@latkit/network'))), 'assets'),
  join(browserRoot, 'assets'),
  { recursive: true },
)
const node = { platform: 'node', format: 'cjs', target: 'node20' }
const browser = { platform: 'browser', format: 'esm', target: 'es2022' }
const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.cjs',
    ...node,
    external: ['vscode'],
  },
  { entryPoints: ['src/table/worker.ts'], outfile: 'dist/table/worker.cjs', ...node },
  { entryPoints: ['src/parser/worker.ts'], outfile: 'dist/parser/worker.cjs', ...node },
  { entryPoints: ['src/csv/worker.ts'], outfile: 'dist/csv/worker.cjs', ...node },
  { entryPoints: ['src/network/page/main.ts'], outfile: browserRoot + '/main.js', ...browser },
  { entryPoints: ['src/monitor/page/main.ts'], outfile: 'dist/monitor/main.js', ...browser },
  {
    entryPoints: ['src/table/page/main.ts'],
    outfile: 'dist/table/main.js',
    ...browser,
    conditions: ['browser'],
    plugins: [svelte({ compilerOptions: { css: 'external' } })],
  },
  {
    entryPoints: ['src/simulation/page/main.ts'],
    outfile: 'dist/simulation/main.js',
    ...browser,
    conditions: ['browser'],
    plugins: [svelte({ compilerOptions: { css: 'external' } })],
  },
]
await Promise.all(
  builds.map(async (options) => {
    const config = {
      ...options,
      bundle: true,
      mainFields: ['module', 'main'],
      sourcemap: true,
      logLevel: 'info',
    }
    if (process.argv.includes('--watch')) await (await context(config)).watch()
    else await build(config)
  }),
)
