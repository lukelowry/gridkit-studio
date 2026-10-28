/** Bundle the extension and its two workers for Node, and the webviews for the browser, into dist/.
 *  `--watch` rebuilds on change, unminified. */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build, context } from 'esbuild'
import svelte from 'esbuild-svelte'

const root = dirname(fileURLToPath(import.meta.url))
const output = resolve(root, 'dist')
const watch = process.argv.includes('--watch')
const require = createRequire(import.meta.url)
const packageRoot = resolve(dirname(require.resolve('latkit')), '..')
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
if (manifest.version !== '0.3.1')
  throw new Error(`Expected latkit 0.3.1, found ${manifest.version}`)

await rm(output, { recursive: true, force: true })
await mkdir(resolve(output, 'webview'), { recursive: true })
await mkdir(resolve(output, 'licenses'), { recursive: true })
const retirement = {
  name: 'retired-latkit-packages',
  setup(builder) {
    builder.onEnd((result) => {
      const old = Object.keys(result.metafile?.inputs ?? {}).filter((name) =>
        /@latkit(?:[\\/+]|\b)/.test(name),
      )
      if (old.length)
        return {
          errors: [{ text: `Retired Latkit packages entered the bundle:\n${old.join('\n')}` }],
        }
    })
  },
}
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
    outfile: 'dist/extension.cjs',
    platform: 'node',
    mainFields: ['module', 'main'],
    format: 'cjs',
    target: 'node22',
    external: ['vscode'],
    plugins: [retirement],
  },
  {
    entryPoints: { cases: 'src/workers/cases.ts', results: 'src/workers/results.ts' },
    outdir: 'dist',
    outExtension: { '.js': '.mjs' },
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);",
    },
    plugins: [retirement],
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
    plugins: [svelte({ compilerOptions: { css: 'external' } }), retirement],
  },
]
await Promise.all([
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
    await writeFile(
      resolve(output, `metafile-${options.platform}-${options.format}.json`),
      JSON.stringify(result.metafile),
    )
  }
}
