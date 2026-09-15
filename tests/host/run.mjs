import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runTests } from '@vscode/test-electron'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../../', import.meta.url))
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
  }),
)
const workspace = path.join(run, 'workspace')
await mkdir(workspace)
await copyFile(
  path.join(root, 'tests/fixtures/solver/two-bus.case.json'),
  path.join(workspace, 'two bus.case.json'),
)

const extensionTestsPath = path.join(root, 'output/tests/host.cjs')
await build({
  entryPoints: [path.join(root, 'tests/host/index.ts')],
  outfile: extensionTestsPath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  mainFields: ['module', 'main'],
  external: ['vscode', 'playwright-core'],
})

await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath,
  // Embedded terminals may inherit Electron's Node-only mode.
  extensionTestsEnv: {
    ELECTRON_RUN_AS_NODE: undefined,
    GRIDKIT_TEST_PROFILE: profile,
    GRIDKIT_TEST_SOLVER: process.env.GRIDKIT_TEST_SOLVER,
  },
  version: process.env.VSCODE_VERSION ?? 'stable',
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
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-updates',
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    '--user-data-dir',
    profile,
    '--extensions-dir',
    path.join(run, 'extensions'),
  ],
})

// Remove only the unique test-owned profile after a successful host exit.
const relative = path.relative(testRoot, run)
if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
  throw new Error('Test profile escaped its root.')
await rm(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
