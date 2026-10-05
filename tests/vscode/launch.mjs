/** Start VS Code with the extension and a case in a profile of its own, and run an entry inside
 *  it: VS Code suites, or the entry named on the command line. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const untrusted = process.argv.includes('--untrusted')
const entry =
  process.argv.slice(2).find((value) => !value.startsWith('--')) ?? 'tests/vscode/index.ts'
const testRoot = path.join(root, '.vscode-test')
await mkdir(testRoot, { recursive: true })
const run = await mkdtemp(path.join(testRoot, 'run-'))
const profile = path.join(run, 'user-data')
await mkdir(path.join(profile, 'User'), { recursive: true })
// Use VS Code's DOM menus on every OS so browser tests can inspect native contributions.
await writeFile(
  path.join(profile, 'User', 'settings.json'),
  JSON.stringify({
    'window.titleBarStyle': 'custom',
    'window.menuStyle': 'custom',
    // Keep native pickers open across headless focus changes.
    'workbench.quickOpen.closeOnFocusLost': false,
    'workbench.startupEditor': 'none',
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'security.workspace.trust.startupPrompt': 'never',
    // An install of GridKit other than the one on PATH, or an image to run without one.
    ...(process.env.GRIDKIT_PATH && { 'gridkitStudio.gridkitPath': process.env.GRIDKIT_PATH }),
    ...(process.env.GRIDKIT_IMAGE && { 'gridkitStudio.gridkitImage': process.env.GRIDKIT_IMAGE }),
    ...(process.env.GRIDKIT_CONTAINER_CLI && {
      'gridkitStudio.containerCli': process.env.GRIDKIT_CONTAINER_CLI,
    }),
  }),
)
const workspace = path.join(run, 'workspace')
await mkdir(workspace)
await copyFile(
  path.join(root, 'tests/fixtures/IEEE39.case.json'),
  path.join(workspace, 'IEEE39.case.json'),
)

const extensionTestsPath = path.join(root, 'output/tests/vscode.cjs')
await build({
  entryPoints: [path.join(root, entry)],
  outfile: extensionTestsPath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  mainFields: ['module', 'main'],
  external: ['vscode', 'playwright-core', 'mocha'],
})

const options = {
  extensionDevelopmentPath: process.env.GRIDKIT_TEST_EXTENSION_PATH ?? root,
  extensionTestsPath,
  // Embedded terminals may inherit Electron's Node-only mode.
  extensionTestsEnv: {
    ELECTRON_RUN_AS_NODE: undefined,
    GRIDKIT_TEST_PROFILE: profile,
    GRIDKIT_TEST_ROOT: root,
    GRIDKIT_TEST_OUTPUT: process.env.GRIDKIT_TEST_OUTPUT ?? path.join(root, 'output'),
  },
  version: process.env.VSCODE_VERSION ?? manifest.engines.vscode.replace(/^\^/, ''),
  ...(process.env.VSCODE_EXECUTABLE_PATH && {
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
  }),
  launchArgs: [
    workspace,
    '--remote-debugging-port=0',
    // Match Playwright's input and scheduling defaults for this externally launched browser.
    '--allow-pre-commit-input',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...(process.env.GRIDKIT_TEST_SOFTWARE_GPU === '1'
      ? [
          '--enable-unsafe-webgpu',
          '--use-webgpu-adapter=swiftshader',
          '--use-angle=swiftshader',
          '--enable-features=Vulkan',
          '--use-vulkan=swiftshader',
          '--disable-vulkan-surface',
        ]
      : []),
    '--disable-extensions',
    ...(!untrusted ? ['--disable-workspace-trust'] : []),
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-updates',
    // Chromium's sandbox needs what neither root nor a container gives it.
    ...(process.getuid?.() === 0 || existsSync('/.dockerenv') ? ['--no-sandbox'] : []),
    '--user-data-dir',
    profile,
    '--extensions-dir',
    path.join(run, 'extensions'),
  ],
}
if (untrusted) {
  // test-electron's runTests always disables Workspace Trust. Launch its downloaded executable
  // directly for this test so it exercises VS Code's real restricted-workspace behavior.
  const executable = options.vscodeExecutablePath ?? (await downloadAndUnzipVSCode(options.version))
  await new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        ...options.launchArgs,
        '--extensionDevelopmentPath=' + options.extensionDevelopmentPath,
        '--extensionTestsPath=' + options.extensionTestsPath,
      ],
      {
        env: { ...process.env, ...options.extensionTestsEnv },
        stdio: 'inherit',
        windowsHide: true,
        timeout: 120000,
      },
    )
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('Trust test exited ' + code)),
    )
  })
} else await runTests(options)

// Remove only the unique test-owned profile after a successful host exit.
const relative = path.relative(testRoot, run)
if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
  throw new Error('Test profile escaped its root.')
await rm(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
