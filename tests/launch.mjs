/** Runs a test entry (default: the host suites) in VS Code with a throwaway profile. `--untrusted`
 *  keeps Workspace Trust on; GRIDKIT_TEST_VERBOSE=1 keeps VS Code's routine log lines. */

import { spawn } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { downloadAndUnzipVSCode } from '@vscode/test-electron'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const untrusted = process.argv.includes('--untrusted')
const entry =
  process.argv.slice(2).find((value) => !value.startsWith('--')) ?? 'tests/host/index.ts'
const NOISE = [
  /^\[main [^\]]+\] (StorageMainService|\[shared storage\]|update#|Extension host with pid \d+ exited with code: 0|CodeWindow: failed to load \(reason: [^)]*, code: -3\))/,
  /^DevTools listening on ws:/,
  /^(Started|Completed) initializing default profile extensions/,
  /^Started local extension host with pid/,
  /^Loading development extension at/,
  /^\[AccountPolicyGate\] /,
  /^Settings Sync: Account status changed/,
  // VS Code's proxy code, on the first web request a built-in extension makes.
  /^\(node:\d+\) \[DEP0169\]/,
  /^\(Use `Code --trace-deprecation/,
]

const extensionTestsPath = path.join(
  root,
  'output/tests',
  entry
    .replace(/^tests[\\/]/, '')
    .replace(/\.ts$/, '')
    .replace(/[\\/]/g, '-') + '.cjs',
)
await build({
  stdin: {
    contents: `import { run as suite } from ${JSON.stringify('./' + entry.replaceAll('\\', '/'))};
import { writeFileSync } from 'node:fs';
export async function run() {
  await suite();
  writeFileSync(process.env.GRIDKIT_TEST_COMPLETE, 'complete');
}`,
    resolveDir: root,
    sourcefile: 'test-entry.mjs',
  },
  outfile: extensionTestsPath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  mainFields: ['module', 'main'],
  external: ['vscode', 'playwright-core', 'mocha'],
  logLevel: 'warning',
})

const output = process.env.GRIDKIT_TEST_OUTPUT ?? path.join(root, 'output')
const testRoot = path.join(root, '.vscode-test')
await mkdir(testRoot, { recursive: true })
const run = await mkdtemp(path.join(testRoot, 'run-'))
const completed = path.join(run, 'completed')
let passed = false
try {
  const profile = path.join(run, 'user-data')
  await mkdir(path.join(profile, 'User'), { recursive: true })
  await writeFile(
    path.join(profile, 'User', 'settings.json'),
    JSON.stringify({
      // DOM menus on every OS, so Playwright can read them.
      'window.titleBarStyle': 'custom',
      'window.menuStyle': 'custom',
      // Keep quick picks open across headless focus changes.
      'workbench.quickOpen.closeOnFocusLost': false,
      'workbench.startupEditor': 'none',
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'security.workspace.trust.startupPrompt': 'never',
      // The workspace is inside this repository; keep Git from prompting about it.
      'git.openRepositoryInParentFolders': 'never',
      'chat.disableAIFeatures': true,
      'chat.agentHost.claudeAgent.enabled': false,
      'telemetry.telemetryLevel': 'off',
      'workbench.enableExperiments': false,
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': false,
      ...(process.env.GRIDKIT_PATH && { 'gridkitStudio.gridkitPath': process.env.GRIDKIT_PATH }),
    }),
  )
  const workspace = path.join(run, 'workspace')
  await mkdir(workspace)
  for (const file of ['IEEE39.case.json', 'IEEE39.solver.json'])
    await copyFile(path.join(root, 'cases', file), path.join(workspace, file))

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
      // Playwright's input and scheduling defaults, for a browser it did not launch.
      '--allow-pre-commit-input',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      ...(process.env.GRIDKIT_TEST_SOFTWARE_GPU === '1'
        ? [
            // Software WebGL2, which Chromium enables only on request.
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            // Large CPU-drawn plots outlast the watchdog, which kills the GPU process and, after
            // two kills, disables WebGL for the rest of the run.
            '--disable-gpu-watchdog',
          ]
        : []),
      // Chromium's sandbox does not work as root or in a container.
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
        // Set as the `code` command does, so Chromium flags pass without warnings.
        VSCODE_CLI: '1',
        GRIDKIT_TEST_PROFILE: profile,
        GRIDKIT_TEST_ROOT: root,
        GRIDKIT_TEST_OUTPUT: output,
        GRIDKIT_TEST_COMPLETE: completed,
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
  if ((await readFile(completed, 'utf8').catch(() => '')) !== 'complete')
    throw new Error(
      'VS Code exited before the test entry completed. Check the extension-host logs.',
    )
  passed = true
} finally {
  if (!passed) {
    const logs = path.join(output, 'logs', path.basename(run))
    await cp(path.join(run, 'user-data', 'logs'), logs, { recursive: true }).then(
      () => console.warn("Kept the run's logs in " + logs),
      () => {},
    )
  }
  // Remove only this run's profile, whether or not it passed.
  const relative = path.relative(testRoot, run)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Test profile escaped its root.')
  await rm(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((error) =>
    console.warn('Kept the test profile ' + run + ': ' + error.message),
  )
}
