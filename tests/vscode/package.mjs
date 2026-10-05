/** Install the packaged VSIX into a VS Code of its own, check what it holds, and run the VS Code
 *  suites against it. */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { downloadAndUnzipVSCode } from '@vscode/test-electron'

const root = fileURLToPath(new URL('../../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const vsix = join(root, 'dist', manifest.name + '-' + manifest.version + '.vsix')
await mkdir(join(root, 'output'), { recursive: true })
const scratch = await mkdtemp(join(root, 'output', 'packaged-'))
const extensions = join(scratch, 'extensions')
const profile = join(scratch, 'profile')
await mkdir(extensions)
const executable =
  process.env.VSCODE_EXECUTABLE_PATH ??
  (await downloadAndUnzipVSCode(
    process.env.VSCODE_VERSION ?? manifest.engines.vscode.replace(/^\^/, ''),
  ))
// VS Code's CLI script, run by its own executable. test-electron's CLI path is a .cmd on Windows,
// which only a shell can run.
const app = join('resources', 'app', 'out', 'cli.js')
const cli = [
  join(dirname(executable), app),
  join(dirname(executable), '..', 'Resources', 'app', 'out', 'cli.js'),
  // Windows keeps it in a folder named for the commit.
  ...(await readdir(dirname(executable))).map((name) => join(dirname(executable), name, app)),
].find((candidate) => existsSync(candidate))
assert.ok(cli, 'No VS Code CLI beside ' + executable)

const run = (executable, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('Process exited ' + code)),
    )
  })
/** Fail on anything the VSIX should not ship: dependencies, which the bundles hold, or a schema
 *  file. */
async function verify(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    if (item.isDirectory()) {
      assert.notEqual(item.name, 'node_modules')
      await verify(path)
    } else assert.ok(!item.name.endsWith('.schema.json'), 'Unexpected authored schema in VSIX')
  }
}

try {
  await run(
    executable,
    [
      cli,
      '--install-extension',
      vsix,
      '--force',
      '--extensions-dir',
      extensions,
      '--user-data-dir',
      profile,
    ],
    { ELECTRON_RUN_AS_NODE: '1' },
  )
  const installed = (await readdir(extensions)).find((name) =>
    name.startsWith(manifest.publisher + '.' + manifest.name + '-'),
  )
  assert.ok(installed, 'VSIX was not installed')
  const target = resolve(extensions, installed)
  const packaged = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
  assert.deepEqual(packaged.dependencies, manifest.dependencies)
  assert.equal(packaged.version, manifest.version)
  assert.equal(packaged.engines.vscode, manifest.engines.vscode)
  await verify(target)
  await run(process.execPath, [join(root, 'tests/vscode/launch.mjs')], {
    ELECTRON_RUN_AS_NODE: undefined,
    GRIDKIT_TEST_EXTENSION_PATH: target,
    GRIDKIT_TEST_OUTPUT: scratch,
  })
  console.log('Installed VSIX verified:', vsix)
  console.log('VS Code report:', join(scratch, 'tests', 'vscode-report.json'))
} finally {
  // Keep the screenshots and report; drop the installed copy and its profile.
  for (const directory of [extensions, profile])
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      (error) => console.warn('Kept ' + directory + ': ' + error.message),
    )
}
