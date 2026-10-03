import { spawn } from 'node:child_process'

import { build } from 'esbuild'
await build({
  entryPoints: ['tests/solver/index.ts'],
  outfile: 'output/tests/solver.cjs',
  bundle: true,
  platform: 'node',
  mainFields: ['module', 'main'],
  format: 'cjs',
  target: 'node22',
})
const child = spawn(process.execPath, ['output/tests/solver.cjs'], {
  stdio: 'inherit',
  windowsHide: true,
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
