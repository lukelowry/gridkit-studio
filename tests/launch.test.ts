import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { resolveSolver } from '../src/launch.js'
import { caseText } from './support/case.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(casePatch: object = {}, solverPatch: object = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gridkit-launch-')))
  roots.push(root)
  const solver = join(root, 'case.solver.json')
  await writeFile(
    join(root, 'case.case.json'),
    caseText({ buses: [{ mon: ['Vm'] }], ...casePatch }),
  )
  await writeFile(
    solver,
    JSON.stringify({ system_model_file: 'case.case.json', tmax: 1, events: [], ...solverPatch }),
  )
  return { root, launch: () => resolveSolver(solver, root) }
}
it('rejects an output alias identical to the monitor path, without creating files', async () => {
  const { root, launch } = await fixture(
    { monitors: [{ format: 'CSV', file_name: 'mon.csv' }] },
    { output_file: './mon.csv' },
  )
  await expect(launch()).rejects.toThrow('duplicates')
  await expect(readFile(join(root, 'mon.csv'))).rejects.toThrow()
})
it('preserves an existing regular file where GridKit would require a symlink', async () => {
  const { root, launch } = await fixture(
    { monitors: [{ format: 'CSV', file_name: 'mon.csv' }] },
    { output_file: 'alias.csv' },
  )
  await writeFile(join(root, 'alias.csv'), 'previous output')
  await expect(launch()).rejects.toThrow('symlink')
  expect(await readFile(join(root, 'alias.csv'), 'utf8')).toBe('previous output')
})
it('rejects an alias whose relative target would resolve in the wrong directory', async () => {
  const { root, launch } = await fixture(
    { monitors: [{ format: 'CSV', file_name: 'mon.csv' }] },
    { output_file: 'results/alias.csv' },
  )
  await mkdir(join(root, 'results'))
  await expect(launch()).rejects.toThrow('wrong directory')
})
it('honors a final unnamed CSV sink by selecting the solver output', async () => {
  const { root, launch } = await fixture(
    { monitors: [{ format: 'CSV', file_name: 'first.csv' }, { format: 'CSV' }] },
    { output_file: 'last.csv' },
  )
  const result = await launch()
  expect(result.output).toBe(join(root, 'last.csv'))
  expect(result.outputs).toEqual([join(root, 'first.csv'), join(root, 'last.csv')])
})
it('checks comparison vector width against native deduplicated monitors, excluding time', async () => {
  const wrong = await fixture({}, { output_file: 'mon.csv', error_tolerance: [1e-3, 1e-3] })
  await expect(wrong.launch()).rejects.toThrow('exactly 1 monitored')
  const correct = await fixture(
    { buses: [{ mon: ['Vm', 'vm', 'Va'] }] },
    { output_file: 'mon.csv', error_tolerance: [1e-3, 1e-3] },
  )
  await expect(correct.launch()).resolves.toBeDefined()
})
