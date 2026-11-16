/** Copies GridKit's cases into cases/ byte for byte at the ref the default image is built from (its
 *  `org.opencontainers.image.revision` label). Solver files in cases/ are maintained by hand.
 *
 *    node scripts/cases.mjs ../GridKit 0ff72a120d6b0a895ccefd3db5e2b259e2d25d0f
 *
 *  The cases here have longer `mon` lists than GridKit's, which a copy would undo. To follow a
 *  newer GridKit, apply its `git diff` of each case instead, and use this only for new cases.
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
  ACTIVSg25k: 'ACTIVSg25k/ACTIVSg25k',
  ACTIVSg70k: 'ACTIVSg70k/ACTIVSg70k',
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
