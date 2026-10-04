// Report the Lattice sources Studio ported that have changed upstream since they were taken, so a
// port is revisited when its source moves. Run beside a checkout of Lattice: pnpm lattice:check.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { commit, files } = JSON.parse(readFileSync(new URL('./lattice.json', import.meta.url)))
const lattice = resolve(process.env.LATTICE ?? '../lattice')
if (!existsSync(resolve(lattice, '.git'))) {
  console.error(`No Lattice checkout at ${lattice}. Set LATTICE to one.`)
  process.exit(1)
}
const git = (...args) => execFileSync('git', ['-C', lattice, ...args], { encoding: 'utf8' }).trim()

let moved = 0
for (const [ported, source] of Object.entries(files)) {
  if (!existsSync(ported)) {
    console.log(`${ported}: gone here; drop it from scripts/lattice.json`)
    moved++
    continue
  }
  const log = git('log', '--oneline', `${commit}..HEAD`, '--', source)
  if (log === '') continue
  moved++
  console.log(`${ported}  <-  ${source}\n${log.replace(/^/gm, '    ')}`)
}
console.log(
  moved === 0
    ? `Every ported file matches Lattice ${commit}.`
    : `${moved} ported files have newer sources. Port the changes, then record the new commit.`,
)
process.exit(moved === 0 ? 0 : 1)
