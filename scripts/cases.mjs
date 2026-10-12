/** GridKit's cases, copied into cases/ byte for byte as GridKit has them at the ref Studio's default
 *  image is built from, so the samples match the GridKit that runs them. The short solver file
 *  beside each, and ACTIVSg25k and ACTIVSg70k, are kept in cases/ as they are, apart from this.
 *
 *    node scripts/cases.mjs ../GridKit v0.2.0
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CASES = {
  IEEE39: 'IEEE39/IEEE39',
  TwoArea: 'TwoArea/TwoArea',
  TwoBusBasic: 'Toy/TwoBusBasic',
  WECC240: 'WECC240/WECC240',
  ACTIVSg2000: 'ACTIVSg2000/ACTIVSg2000',
  ACTIVSg10k: 'ACTIVSg10k/ACTIVSg10k',
}

const [gridkit, ref] = process.argv.slice(2)
if (!gridkit || !ref) throw new Error('Usage: node scripts/cases.mjs <GridKit checkout> <ref>')
for (const [name, path] of Object.entries(CASES))
  writeFileSync(
    `cases/${name}.case.json`,
    execFileSync(
      'git',
      ['-C', gridkit, 'cat-file', 'blob', `${ref}:cases/PhasorDynamics/${path}.case.json`],
      { encoding: 'buffer', maxBuffer: Infinity },
    ),
  )
