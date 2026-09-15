import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
const root = fileURLToPath(new URL('../../', import.meta.url))
const output = join(root, 'output/tests/solver.mjs')
await build({
  entryPoints: [join(root, 'tests/solver/index.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  mainFields: ['module', 'main'],
})
const child = spawn(process.execPath, [output], {
  stdio: 'inherit',
  cwd: root,
  windowsHide: true,
})
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
