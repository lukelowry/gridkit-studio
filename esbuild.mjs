/** Bundle the extension and its worker for Node, and the webviews for the browser, into dist/.
 *  `--watch` rebuilds on change, unminified. */

import { copyFile, mkdir, rm } from 'node:fs/promises'
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
}
const builds = [
  {
    entryPoints: {
      extension: 'src/extension/index.ts',
      worker: 'src/worker.ts',
      mcp: 'src/mcp.ts',
      'mcp-server': 'src/extension/mcp-server.ts',
      'ai-clients': 'src/extension/ai-clients.ts',
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
      simulation: 'src/webview/simulation.ts',
      monitor: 'src/webview/monitor.ts',
      export: 'src/webview/export.ts',
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
  if (watch) await (await context(config)).watch()
  else {
    const result = await build({ ...config, metafile: true })
    for (const name of ['dist/extension.cjs', 'dist/mcp.cjs']) {
      const inputs = Object.keys(result.metafile.outputs[name]?.inputs ?? {})
      if (inputs.some((path) => path.includes('@modelcontextprotocol')))
        throw new Error('MCP SDK must remain in the lazy server bundle: ' + name)
    }
  }
}

await copyFile('assets/borders.bin', 'dist/webview/borders.bin')
