import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import type { Cases, ReadyCase } from '../src/case.js'
import { validate } from '../src/gridkit/validate.js'
import {
  commitSetup,
  prepareSimulation,
  saveConfiguration,
  setupInput,
} from '../src/simulation/setup.js'
import { caseText } from './support/case.js'
import { window, workspace } from './support/vscode.js'

const roots: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gridkit-config-')))
  roots.push(root)
  const directory = join(root, 'study')
  await mkdir(directory)
  const path = join(root, 'one.case.json')
  const text = caseText({
    buses: [{ mon: ['Vm'] }],
    monitors: [{ format: 'CSV', file_name: 'mon.csv' }],
  })
  await writeFile(path, text)
  const uri = { fsPath: join(directory, 'case.solver.json') }
  const input = { system_model_file: '../one.case.json', tmax: 1, events: [] }
  await writeFile(uri.fsPath, JSON.stringify(input))
  const configuration = { uri, version: 1, isDirty: false, getText: () => JSON.stringify(input) }
  workspace.openTextDocument.mockResolvedValue(configuration as never)
  const state = {
    document: { uri: { fsPath: path }, isDirty: false, version: 1, getText: () => text },
    raw: validate(JSON.parse(text)),
    target: {},
    current: () => true,
    setup: { kind: 'document', uri },
    setSetup: vi.fn(),
  } as unknown as ReadyCase
  const cases = { edit: vi.fn(async () => {}) } as unknown as Cases
  return { root, directory, state, input, configuration, cases }
}
it('rejects a configuration retargeted to another case before editing either case', async () => {
  const { root, state, input, configuration, cases } = await fixture()
  await writeFile(join(root, 'other.case.json'), state.document.getText())
  input.system_model_file = '../other.case.json'
  await writeFile(configuration.uri.fsPath, JSON.stringify(input))
  await expect(prepareSimulation(cases, state, root)).rejects.toThrow('different case')
  expect(cases.edit).not.toHaveBeenCalled()
})
it('invalidates the prepared launch after configuration edits or setup switches', async () => {
  const { root, state, configuration, cases } = await fixture()
  const launch = await prepareSimulation(cases, state, root)
  expect(() => launch.assertCurrent!()).not.toThrow()
  configuration.version++
  expect(() => launch.assertCurrent!()).toThrow('changed')
  configuration.version--
  state.setup = { kind: 'memory', options: { tmax: 1, events: [] } }
  expect(() => launch.assertCurrent!()).toThrow('changed')
})
it('preserves working directory and relative paths through memory edits and launch', async () => {
  const { root, directory, state, cases } = await fixture()
  state.setup = { kind: 'memory', baseDirectory: directory, options: { tmax: 1, events: [] } }
  const before = await setupInput(state)
  expect(before.system_model_file).toBe('../one.case.json')
  await commitSetup(cases, state, state.target, state.setup, before, { ...before, tmax: 2 })
  expect(state.setSetup).toHaveBeenCalledWith(expect.objectContaining({ baseDirectory: directory }))
  const launch = await prepareSimulation(cases, state, root)
  expect(dirname(launch.solver)).toBe(directory)
  expect(launch.output).toBe(join(directory, 'mon.csv'))
  await launch.cleanup!()
  expect(await readdir(directory)).toEqual(['case.solver.json'])
})
it('rejects Save As that would silently move case monitor targets', async () => {
  const { root, state } = await fixture()
  window.showSaveDialog.mockResolvedValueOnce({ fsPath: join(root, 'moved.solver.json') })
  await expect(saveConfiguration(state)).rejects.toThrow('relative monitor filenames')
  expect(await readdir(root)).not.toContain('moved.solver.json')
  expect(state.setSetup).not.toHaveBeenCalled()
})
