import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'

import { CaseState } from '../src/case.js'
import { parse } from '../src/gridkit/parse.js'
import type { SolverLaunch } from '../src/launch.js'
import { Run } from '../src/run.js'
import { executeSolver } from '../src/runtime.js'
import { caseBytes } from './support/case.js'
import { languages } from './support/vscode.js'
vi.mock('../src/runtime.js', () => ({ executeSolver: vi.fn() }))
const states: CaseState[] = []
afterEach(() => {
  for (const state of states.splice(0)) state.dispose()
  vi.clearAllMocks()
})
function fixture() {
  const document = {
    uri: { toString: () => `file:///${states.length}.case.json` },
    version: 1,
    isClosed: false,
  } as unknown as vscode.TextDocument
  const state = new CaseState(document, { state: 'valid', version: 1, case: parse(caseBytes({})) })
  states.push(state)
  const launch = {
    raw: state.raw,
    output: join(tmpdir(), 'gridkit-test-absent-output.csv'),
  } as SolverLaunch
  const diagnostics =
    languages.createDiagnosticCollection() as unknown as vscode.DiagnosticCollection
  const run = new Run(state, launch, diagnostics, {
    executable: 'DynamicSimulation',
    args: [],
    cwd: tmpdir(),
  })
  return { run, state, document }
}
function execution() {
  let finish!: (code: number) => void
  const done = new Promise<number>((resolve) => {
    finish = resolve
  })
  const cancel = vi.fn(async () => {
    finish(130)
  })
  vi.mocked(executeSolver).mockReturnValueOnce({ done, cancel })
  return { cancel, finish }
}
it('cancels its own execution without touching another case run', async () => {
  const a = fixture()
  const b = fixture()
  const first = execution()
  const second = execution()
  const one = a.run.start(() => {})
  await vi.waitFor(() => expect(executeSolver).toHaveBeenCalledTimes(1))
  const two = b.run.start(() => {})
  await vi.waitFor(() => expect(executeSolver).toHaveBeenCalledTimes(2))
  await a.run.cancel()
  expect(await one).toBe(130)
  expect(await a.run.done).toBe('cancelled')
  expect(first.cancel).toHaveBeenCalledOnce()
  expect(second.cancel).not.toHaveBeenCalled()
  second.finish(7)
  expect(await two).toBe(1)
  expect(await b.run.done).toBe('failed')
})
it('does not launch when a task was cancelled during preparation', async () => {
  const { run } = fixture()
  await run.cancel()
  expect(await run.start(() => {})).toBe(130)
  expect(executeSolver).not.toHaveBeenCalled()
  expect(await run.done).toBe('cancelled')
})
it('invalidates results and cancels execution when the case revision changes', async () => {
  const { run, state, document } = fixture()
  const process = execution()
  await state.attachRun(run)
  const task = run.start(() => {})
  await vi.waitFor(() => expect(executeSolver).toHaveBeenCalled())
  ;(document as { version: number }).version = 2
  state.update({
    state: 'valid',
    version: 2,
    case: parse(caseBytes({ header: { case_name: 'Changed input' } })),
  })
  expect(state.run).toBeUndefined()
  expect(state.fields!.source).toBeUndefined()
  expect(await task).toBe(130)
  expect(process.cancel).toHaveBeenCalledOnce()
})

it('reports the emitted GridKit exception instead of replacing it with an exit code', async () => {
  const { run } = fixture()
  vi.mocked(executeSolver).mockImplementationOnce((_launch, write) => {
    write(
      'stderr',
      "terminate called after throwing an instance of 'std::bad_variant_access'\n  what(): std::get: wrong index for variant\n",
    )
    return { done: Promise.resolve(139), cancel: async () => {} }
  })
  expect(await run.start(() => {})).toBe(1)
  expect(run.error).toContain('wrong index for variant')
})
it('refreshes available samples after an unsuccessful solver exit', async () => {
  const { run, state } = fixture()
  const scan = vi.fn(async () => ({ headers: ['t', 'Vm'], rows: 2, range: [0, 1] as const }))
  const source = { scan, columns: [{}], info: { rows: 2, range: [0, 1] }, dispose: async () => {} }
  state.source = source as unknown as NonNullable<typeof state.source>
  vi.mocked(executeSolver).mockReturnValueOnce({
    done: Promise.resolve(7),
    cancel: async () => {},
  })
  expect(await run.start(() => {})).toBe(1)
  expect(scan).toHaveBeenCalledWith(false)
  expect(state.source).toBe(source)
})
