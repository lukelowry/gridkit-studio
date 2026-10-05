/** Run an entry inside VS Code with the extension and a case, in a throwaway profile: the VS Code
 *  suites, or the entry named on the command line. `--untrusted` leaves Workspace Trust on.
 *  VS Code's own routine log lines are left out; GRIDKIT_TEST_VERBOSE=1 keeps them. */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { downloadAndUnzipVSCode } from '@vscode/test-electron'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const untrusted = process.argv.includes('--untrusted')
const entry =
  process.argv.slice(2).find((value) => !value.startsWith('--')) ?? 'tests/vscode/index.ts'
/** VS Code's lines that say nothing about the run. */
const NOISE = [
  /^\[main [^\]]+\] (StorageMainService|\[shared storage\]|update#|Extension host with pid \d+ exited with code: 0|CodeWindow: failed to load \(reason: [^)]*, code: -3\))/,
  /^DevTools listening on ws:/,
  /^(Started|Completed) initializing default profile extensions/,
  /^Started local extension host with pid/,
  /^Loading development extension at/,
  /^\[AccountPolicyGate\] /,
  /^Settings Sync: Account status changed/,
  // VS Code's own proxy code, on the first web request any built-in extension makes.
  /^\(node:\d+\) \[DEP0169\]/,
  /^\(Use `Code --trace-deprecation/,
]

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
  logLevel: 'warning',
})

const testRoot = path.join(root, '.vscode-test')
await mkdir(testRoot, { recursive: true })
const run = await mkdtemp(path.join(testRoot, 'run-'))
try {
  const profile = path.join(run, 'user-data')
  await mkdir(path.join(profile, 'User'), { recursive: true })
  await writeFile(
    path.join(profile, 'User', 'settings.json'),
    JSON.stringify({
      // DOM menus on every OS, so Playwright can read native menus.
      'window.titleBarStyle': 'custom',
      'window.menuStyle': 'custom',
      // Native pickers stay open across headless focus changes.
      'workbench.quickOpen.closeOnFocusLost': false,
      'workbench.startupEditor': 'none',
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'security.workspace.trust.startupPrompt': 'never',
      // No AI agent host, experiments, telemetry or update checks: none is part of the run.
      // Chat agents stay enabled, and with them the language-model tools.
      'chat.disableAIFeatures': true,
      'chat.agentHost.claudeAgent.enabled': false,
      'telemetry.telemetryLevel': 'off',
      'workbench.enableExperiments': false,
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
      // An install of GridKit other than the one on PATH, or an image other than the default.
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
    path.join(root, 'cases/IEEE39.case.json'),
    path.join(workspace, 'IEEE39.case.json'),
  )

  const executable =
    process.env.VSCODE_EXECUTABLE_PATH ??
    (await downloadAndUnzipVSCode({
      version: process.env.VSCODE_VERSION ?? manifest.engines.vscode.replace(/^\^/, ''),
      reporter: { report() {}, error: (error) => console.error(error) },
    }))
  const child = spawn(
    executable,
    [
      workspace,
      '--remote-debugging-port=0',
      // Playwright's own input and scheduling defaults, for a browser it did not launch.
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
      // Chromium's sandbox needs what neither root nor a container gives it.
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-extensions',
      '--disable-extension',
      'GitHub.copilot-chat',
      ...(untrusted ? [] : ['--disable-workspace-trust']),
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-updates',
      '--user-data-dir',
      profile,
      '--extensions-dir',
      path.join(run, 'extensions'),
      '--extensionDevelopmentPath=' + (process.env.GRIDKIT_TEST_EXTENSION_PATH ?? root),
      '--extensionTestsPath=' + extensionTestsPath,
    ],
    {
      env: {
        ...process.env,
        // Embedded terminals may inherit Electron's Node-only mode.
        ELECTRON_RUN_AS_NODE: undefined,
        // As the `code` command sets it: Chromium flags pass without a warning each.
        VSCODE_CLI: '1',
        GRIDKIT_TEST_PROFILE: profile,
        GRIDKIT_TEST_ROOT: root,
        GRIDKIT_TEST_OUTPUT: process.env.GRIDKIT_TEST_OUTPUT ?? path.join(root, 'output'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const verbose = process.env.GRIDKIT_TEST_VERBOSE === '1'
  for (const [from, to] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ])
    createInterface({ input: from, crlfDelay: Infinity }).on('line', (line) => {
      if (verbose || !NOISE.some((pattern) => pattern.test(line))) to.write(line + '\n')
    })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (code !== 0) throw new Error(`VS Code exited ${code}.`)
} finally {
  // Remove only this run's own profile, whether or not the run passed.
  const relative = path.relative(testRoot, run)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Test profile escaped its root.')
  await rm(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((error) =>
    console.warn('Kept the test profile ' + run + ': ' + error.message),
  )
}
