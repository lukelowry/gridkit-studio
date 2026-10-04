import { spawn } from 'node:child_process'

import { build } from 'esbuild'
await build({
  entryPoints: ['tests/benchmarks/performance.ts'],
  outfile: 'output/tests/performance.cjs',
  bundle: true,
  platform: 'node',
  mainFields: ['module', 'main'],
  format: 'cjs',
  target: 'node22',
})
const child = spawn(process.execPath, ['--expose-gc', 'output/tests/performance.cjs'], {
  stdio: 'inherit',
  windowsHide: true,
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
