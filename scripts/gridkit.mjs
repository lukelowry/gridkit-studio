/**
 * Real-GridKit tests from any host with Docker, in the image the dev container and CI build from
 * .devcontainer/ (GridKit pinned by digest). The container tests a copy of this checkout, so the
 * host's node_modules, dist and .vscode-test are never touched. Results land in output/gridkit/.
 *
 *   pnpm test:gridkit             real solver tests, then the VS Code Run, WECC240 and visual suites
 *   pnpm test:gridkit --required  the release check CI runs (pnpm test:devcontainer)
 *   pnpm test:baselines           regenerate the pixel baselines into tests/vscode/baselines/
 */
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const IMAGE = 'gridkit-studio-test:local'
const mode = process.argv.find((arg) => arg.startsWith('--')) ?? '--quick'
const out = resolve('output/gridkit')
function run(command, args) {
  const { status, error } = spawnSync(command, args, { stdio: 'inherit' })
  if (error) throw error
  if (status !== 0) process.exit(status ?? 1)
}

// The CLI by its script, so no shell parses the command on Windows; Docker caches the layers.
const cli = createRequire(import.meta.url).resolve('@devcontainers/cli/devcontainer.js')
run(process.execPath, [cli, 'build', '--workspace-folder', '.', '--image-name', IMAGE])
rmSync(out, { recursive: true, force: true })
mkdirSync(resolve(out, 'baselines'), { recursive: true })
const inside = [
  'tar -C /src --exclude=./node_modules --exclude=./.vscode-test --exclude=./output --exclude=./dist -cf - . | tar -C /work -xf -',
  'cd /work',
  'npm install --global pnpm@10.30.0 > /dev/null',
  'pnpm install --frozen-lockfile --store-dir /pnpm-store',
  `node scripts/devcontainer.mjs ${mode}`,
].join(' && ')
run('docker', [
  'run',
  '--rm',
  '--user',
  'root',
  '--shm-size=2g',
  '-v',
  `${process.cwd()}:/src:ro`,
  '-v',
  `${out}:/out`,
  // Kept between runs: downloaded packages, and VS Code.
  '-v',
  'gridkit-studio-pnpm:/pnpm-store',
  '-v',
  'gridkit-studio-vscode:/work/.vscode-test',
  IMAGE,
  'bash',
  '-lc',
  `{ ${inside}; }; status=$?; cp -r /work/output/. /out/ 2>/dev/null; ` +
    'cp /work/tests/vscode/baselines/*.png /out/baselines/ 2>/dev/null; exit $status',
])
if (mode === '--baselines')
  cpSync(resolve(out, 'baselines'), resolve('tests/vscode/baselines'), { recursive: true })
