import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

import { runTests } from '@vscode/test-web'
import { build } from 'esbuild'

import { browserPlatform } from '../scripts/platform.mjs'

const require = createRequire(createRequire(import.meta.url).resolve('@vscode/test-web'))
const cli = resolve(dirname(require.resolve('playwright/package.json')), 'cli.js')
execFileSync(
  process.execPath,
  [cli, 'install', ...(process.argv.includes('--install-deps') ? ['--with-deps'] : []), 'chromium'],
  { stdio: 'inherit', windowsHide: true },
)
const watchdog = setTimeout(() => {
  console.error('Browser tests timed out.')
  process.exit(1)
}, 120_000)
const root = resolve('.')
const tests = resolve('output/browser/index.cjs')
await build({
  entryPoints: ['tests/browser/index.ts'],
  outfile: tests,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  external: ['vscode'],
  plugins: [browserPlatform],
})
await runTests({
  browserType: 'chromium',
  quality: 'stable',
  headless: true,
  extensionDevelopmentPath: root,
  extensionTestsPath: tests,
  folderPath: resolve('cases'),
  testRunnerDataDir: resolve('.vscode-test/web'),
  verbose: true,
})

clearTimeout(watchdog)
