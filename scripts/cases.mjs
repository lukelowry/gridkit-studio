/** GridKit's release cases, copied into cases/ without their BusFault devices: Studio adds the
 *  faults a run asks for. Every other byte is as the release has it.
 *
 *    node scripts/cases.mjs ../GridKit v0.2.0
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import { applyEdits, modify } from 'jsonc-parser'

const CASES = {
  IEEE39: 'IEEE39/IEEE39',
  TwoArea: 'TwoArea/TwoArea',
  TwoBusBasic: 'Toy/TwoBusBasic',
  WECC240: 'WECC240/WECC240',
  ACTIVSg2000: 'ACTIVSg2000/ACTIVSg2000',
  ACTIVSg10k: 'ACTIVSg10k/ACTIVSg10k',
}

const [gridkit, tag] = process.argv.slice(2)
if (!gridkit || !tag) throw new Error('Usage: node scripts/cases.mjs <GridKit checkout> <tag>')
for (const [name, path] of Object.entries(CASES)) {
  let text = execFileSync(
    'git',
    ['-C', gridkit, 'cat-file', 'blob', `${tag}:cases/PhasorDynamics/${path}.case.json`],
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  )
  const devices = JSON.parse(text).devices ?? []
  let removed = 0
  for (let i = devices.length - 1; i >= 0; i--)
    if (devices[i].class === 'BusFault') {
      text = applyEdits(text, modify(text, ['devices', i], undefined, {}))
      removed++
    }
  writeFileSync(`cases/${name}.case.json`, text)
  console.log(`${name}: ${devices.length - removed} devices, ${removed} BusFault removed`)
}
