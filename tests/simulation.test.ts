import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyEdits } from 'jsonc-parser'
import { expect, it, vi } from 'vitest'

import type { Cases, ReadyCase } from '../src/case.js'
import { nativeCaseEdits } from '../src/gridkit/edit.js'
import { validate } from '../src/gridkit/validate.js'
import { prepareSimulation } from '../src/simulation/setup.js'
import { caseText } from './support/case.js'
import { workspace } from './support/vscode.js'

const cases = { edit: vi.fn(async () => {}) } as unknown as Cases

it('runs a bare case through native solver input and cleans up only its temporary configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gridkit-setup-'))
  try {
    const path = join(root, 'plain.case.json')
    const text = caseText({ buses: [{ number: 1, mon: ['Vm'] }] })
    await writeFile(path, text)
    const state = {
      document: { uri: { fsPath: path }, isDirty: false, getText: () => text },
      current: () => true,
      raw: validate(JSON.parse(text)),
      setup: { kind: 'memory', options: { tmax: 1, events: [] } },
    } as unknown as ReadyCase
    const launch = await prepareSimulation(cases, state, root)
    expect(launch.case).toBe(await realpath(path))
    expect(launch.input.system_model_file).toBe('plain.case.json')
    expect(launch.output).toBe(join(await realpath(root), 'plain.mon.csv'))
    expect(await readFile(path, 'utf8')).toBe(text)
    await launch.cleanup!()
    expect(await readdir(root)).toEqual(['plain.case.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it('cleans temporary input after preparation fails and rejects cases outside the workspace before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gridkit-setup-'))
  try {
    const path = join(root, 'plain.case.json')
    const text = caseText({})
    await writeFile(path, text)
    const state = {
      document: { uri: { fsPath: path }, isDirty: false, getText: () => text },
      current: () => true,
      raw: validate(JSON.parse(text)),
      setup: { kind: 'memory', options: { tmax: 1, events: [], reference_file: 'missing.csv' } },
    } as unknown as ReadyCase
    await expect(prepareSimulation(cases, state, root)).rejects.toThrow()
    expect(await readdir(root)).toEqual(['plain.case.json'])
    const outside = join(root, 'child')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(outside)
    await expect(prepareSimulation(cases, state, outside)).rejects.toThrow('inside')
    expect(await readdir(root)).toEqual(['child', 'plain.case.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['memory', 'document'] as const)(
  'formats fault parameters from the current buffer before a %s run',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'gridkit-format-'))
    try {
      const path = join(root, 'fault.case.json')
      const original = caseText({
        buses: [{ number: 1, mon: ['Vm'] }],
        devices: [
          {
            class: 'BusFault',
            id: 'fault',
            ports: { bus: 1 },
            params: { R: 0, X: 1, state0: false },
          },
        ],
      })
      await writeFile(path, original)
      let text = original.replace('"R":0', '"R":2')
      const before = text
      const document = {
        uri: { fsPath: path },
        version: 2,
        isDirty: true,
        getText: () => text,
        save: vi.fn(async () => {
          await writeFile(path, text)
          document.isDirty = false
          return true
        }),
      }
      const setup = { kind: 'memory', options: { tmax: 1, events: [] } }
      const state = {
        current: () => true,
        document,
        raw: validate(JSON.parse(text)),
        setup,
      } as unknown as ReadyCase
      const cases = {
        edit: vi.fn<Cases['edit']>(async (changes) => {
          expect(changes[0].version).toBe(document.version)
          text = applyEdits(text, [...changes[0].edits])
        }),
      } as unknown as Cases
      if (kind === 'document') {
        const uri = { fsPath: join(root, 'fault.solver.json') }
        await writeFile(
          uri.fsPath,
          JSON.stringify({
            system_model_file: 'fault.case.json',
            output_file: 'fault.mon.csv',
            tmax: 1,
            events: [],
          }),
        )
        state.setup = { kind, uri } as ReadyCase['setup']
        workspace.openTextDocument.mockResolvedValueOnce({
          uri,
          isDirty: false,
          version: 1,
          getText: () =>
            JSON.stringify({
              system_model_file: 'fault.case.json',
              output_file: 'fault.mon.csv',
              tmax: 1,
              events: [],
            }),
        } as never)
      }
      const launch = await prepareSimulation(cases, state, root)
      const saved = await readFile(path, 'utf8')
      expect(saved).not.toBe(before)
      expect(JSON.parse(saved)).toEqual(JSON.parse(before))
      expect(nativeCaseEdits(saved, launch.raw)).toEqual([])
      expect(launch.raw.devices[0].params.R).toBe(2)
      expect(document.save).toHaveBeenCalledOnce()
      await launch.cleanup?.()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
