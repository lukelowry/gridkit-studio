/** The required release check: real GridKit, followed by the installed VSIX in a fresh profile. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync('/.dockerenv'))
  throw new Error('Run pnpm test:devcontainer inside the dev container.')
if (process.env.GRIDKIT_TEST_GREP) throw new Error('The required suite cannot be filtered.')
if (process.env.GRIDKIT_UPDATE_BASELINES)
  throw new Error('Review baseline updates separately before running the required suite.')
const env = { ...process.env, GRIDKIT_TEST_REQUIRED: '1', GRIDKIT_TEST_SOFTWARE_GPU: '1' }
for (const [command, ...args] of [
  ['pnpm', 'quality'],
  ['pnpm', 'test:simulation'],
  ['pnpm', 'package'],
  ['dbus-run-session', '--', 'xvfb-run', '-a', 'pnpm', 'test:package'],
  ['dbus-run-session', '--', 'xvfb-run', '-a', 'pnpm', 'test:trust'],
]) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    )
  })
}
