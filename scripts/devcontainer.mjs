/** The GridKit layers, inside the dev container: CI, or `pnpm test:gridkit` from any host.
 *    --required   the release check (the default): quality, real solver, installed VSIX, trust
 *    --quick      the real solver, then the VS Code Run, WECC240 and visual suites
 *    --baselines  regenerate the pixel baselines, to inspect before committing */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync('/.dockerenv'))
  throw new Error('This runs inside the dev container; from a host, run pnpm test:gridkit.')
const mode = process.argv[2] ?? '--required'
const display = ['dbus-run-session', '--', 'xvfb-run', '-a']
const ui = (grep, extra = {}) => [
  { GRIDKIT_TEST_GREP: grep, ...extra },
  ...display,
  'pnpm',
  'test:vscode',
]
const steps = {
  '--required': [
    [{}, 'pnpm', 'quality'],
    [{}, 'pnpm', 'test:simulation'],
    [{}, 'pnpm', 'package'],
    [{}, ...display, 'pnpm', 'test:package'],
    [{}, ...display, 'pnpm', 'test:trust'],
  ],
  '--quick': [[{}, 'pnpm', 'test:simulation'], ui('Run|WECC240|Visual baselines')],
  '--baselines': [ui('Visual baselines', { GRIDKIT_UPDATE_BASELINES: '1' })],
}[mode]
if (!steps) throw new Error('Unknown mode: ' + mode)
if (
  mode === '--required' &&
  (process.env.GRIDKIT_TEST_GREP || process.env.GRIDKIT_UPDATE_BASELINES)
)
  throw new Error('The required suite cannot be filtered or update baselines.')
const env = { ...process.env, GRIDKIT_TEST_REQUIRED: '1', GRIDKIT_TEST_SOFTWARE_GPU: '1' }
for (const [extra, command, ...args] of steps)
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: { ...env, ...extra } })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    )
  })
