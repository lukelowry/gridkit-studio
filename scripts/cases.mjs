/** GridKit's cases, copied into cases/ byte for byte as GridKit has them at the ref Studio's default
 *  image is built from, so the samples match the GridKit that runs them. That ref is the image's
 *  `org.opencontainers.image.revision` label. The short solver file beside each, and ACTIVSg70k, are
 *  kept in cases/ as they are, apart from this.
 *
 *    node scripts/cases.mjs ../GridKit 0ff72a120d6b0a895ccefd3db5e2b259e2d25d0f
 *
 *  The cases in cases/ list more in their `mon` lists than GridKit's do, which a copy would undo:
 *  to follow a newer GridKit, apply its own diff of each case instead, as `git diff` of the two refs
 *  gives it, and keep this for a case cases/ does not have yet.
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
