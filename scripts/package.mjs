/** Packages the VSIX as it ships, into dist/. An odd minor version (0.7.x) is a pre-release, as VS
 *  Code recommends: the Marketplace keeps each version number to one channel, so a VSIX built
 *  here and one built by CI are the same. */
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const pre = Number(version.split('.')[1]) % 2 === 1
const vsce = createRequire(import.meta.url).resolve('@vscode/vsce/vsce')
execFileSync(
  process.execPath,
  [vsce, 'package', '--no-dependencies', '--out', 'dist/', ...(pre ? ['--pre-release'] : [])],
  { stdio: 'inherit' },
)
