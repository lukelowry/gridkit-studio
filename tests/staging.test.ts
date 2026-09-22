import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { resolveSolver } from '../src/launch.js'
import { recordRuntime, stageLaunch } from '../src/staging.js'
import { caseText } from './support/case.js'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gridkit-stage-')))
  roots.push(root)
  const text = caseText({
    buses: [{ number: 1, mon: ['Vm'] }],
    devices: [{ class: 'BusFault', ports: { bus: 1 }, params: { R: 0, X: 1, state0: false } }],
  })
    .replace('"R":0', '"R":0.0')
    .replace('"X":1', '"X":1.0')
  await writeFile(join(root, 'case.case.json'), text)
  await writeFile(join(root, 'reference.csv'), 't,v\n0,1\n')
  await writeFile(
    join(root, 'case.solver.json'),
    JSON.stringify({
      system_model_file: 'case.case.json',
      output_file: 'results.csv',
      reference_file: 'reference.csv',
      error_tolerance: 0.001,
      tmax: 1,
      events: [],
    }),
  )
  return { root, text, original: await resolveSolver(join(root, 'case.solver.json'), root) }
}
it('runs captured bytes, preserves real tokens, and hashes the exact staged inputs', async () => {
  const { root, text, original } = await fixture()
  const staged = await stageLaunch(original)
  const caseBefore = await readFile(staged.case, 'utf8')
  expect(caseBefore).toContain('0.0')
  expect(caseBefore).toBe(text)
  await writeFile(original.case, 'changed case')
  await writeFile(original.solver, 'changed solver')
  await writeFile(join(root, 'reference.csv'), 'changed reference')
  expect(await readFile(staged.case, 'utf8')).toBe(text)
  expect(await readFile(join(staged.cwd, 'reference.csv'), 'utf8')).toBe('t,v\n0,1\n')
  const command = { executable: process.execPath, args: [staged.solver], cwd: staged.cwd }
  const provenance = await recordRuntime(staged, command)
  expect(provenance).toMatchObject({
    inputs: {
      case: createHash('sha256').update(text).digest('hex'),
      solver: createHash('sha256')
        .update(await readFile(staged.solver))
        .digest('hex'),
    },
    runtime: { executableSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
  })
  expect(JSON.parse(await readFile(join(staged.cwd, 'run.json'), 'utf8'))).toEqual(provenance)
  expect(Object.isFrozen(staged.raw)).toBe(true)
  await staged.dispose!()
  await staged.dispose!()
  expect((await readdir(root)).some((name) => name.startsWith('.gridkit-run-'))).toBe(false)
})
it('keeps existing results intact until success and isolates repeated runs', async () => {
  const { original } = await fixture()
  await writeFile(original.output, 'old results')
  const first = await stageLaunch(original)
  const second = await stageLaunch(original)
  expect(first.output).not.toBe(second.output)
  expect(first.outputs).toEqual(original.outputs)
  await writeFile(first.output, 't,v\n0,2\n')
  expect(await readFile(original.output, 'utf8')).toBe('old results')
  await first.publish!()
  expect(await readFile(original.output, 'utf8')).toBe('t,v\n0,2\n')
  await first.dispose!()
  await second.dispose!()
  expect(await readFile(original.output, 'utf8')).toBe('t,v\n0,2\n')
})
it('removes staging after failed preparation and respects cancellation', async () => {
  const { root, original } = await fixture()
  await rm(join(root, 'reference.csv'))
  await expect(stageLaunch(original)).rejects.toThrow()
  expect((await readdir(root)).some((name) => name.startsWith('.gridkit-run-'))).toBe(false)
  const controller = new AbortController()
  controller.abort()
  await expect(stageLaunch(original, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  })
})

it('publishes solver output aliases as complete files without symlinks and supports reruns', async () => {
  const { root } = await fixture()
  const model = caseText({
    buses: [{ number: 1, mon: ['Vm'] }],
    monitors: [{ format: 'CSV', file_name: 'monitor.csv' }],
  })
  await writeFile(join(root, 'case.case.json'), model)
  await writeFile(join(root, 'alias.csv'), 'previous alias results')
  await writeFile(
    join(root, 'case.solver.json'),
    JSON.stringify({
      system_model_file: 'case.case.json',
      output_file: 'alias.csv',
      tmax: 1,
      events: [],
    }),
  )
  for (let i = 0; i < 2; i++) {
    const original = await resolveSolver(join(root, 'case.solver.json'), root, 'staged')
    const staged = await stageLaunch(original)
    await writeFile(staged.output, 't,v\n0,' + i + '\n')
    await Promise.all([staged.publish!(), staged.publish!()])
    expect(await readFile(join(root, 'alias.csv'), 'utf8')).toBe(
      await readFile(join(root, 'monitor.csv'), 'utf8'),
    )
    await staged.dispose!()
  }
})
