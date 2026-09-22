import { randomUUID } from 'node:crypto'
import { realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

import * as vscode from 'vscode'

import type { Cases, CaseState, ReadyCase } from '../case.js'
import { changeJson, nativeCaseEdits, textEdits } from '../gridkit/edit.js'
import { parseSolver, type SolverInput, type SolverOptions } from '../gridkit/solver.js'
import { resolveSolver, type SolverLaunch, within } from '../launch.js'
import type { CaseTarget } from '../targets.js'
import type { DraftValue } from './messages.js'

export type SimulationSetup =
  | { kind: 'memory'; options: SolverOptions; baseDirectory?: string }
  | { kind: 'document'; uri: vscode.Uri }
export interface SimulationDraft {
  id: string
  inputIdentity: string
  setup: SimulationSetup
  before: SolverInput
  value: DraftValue
}
export const SOLVER_FILES = '**/*.solver.json'
/** Temporary inputs in the setup working directory are never offered as saved configurations. */
export const SOLVER_EXCLUDES = '{**/node_modules/**,**/.git/**,**/.gridkit-*,**/.gridkit-run-*/**}'
export const portable = (path: string) => path.split('\\').join('/')

export function setupDirectory(state: CaseState): string {
  return state.setup.kind === 'document'
    ? dirname(state.setup.uri.fsPath)
    : (state.setup.baseDirectory ?? dirname(state.document.uri.fsPath))
}
async function assertCase(input: SolverInput, base: string, state: CaseState): Promise<void> {
  const [configured, expected] = await Promise.all([
    realpath(resolve(base, input.system_model_file)),
    realpath(state.document.uri.fsPath),
  ])
  if (relative(configured, expected) !== '')
    throw new Error('This configuration belongs to a different case. Open that case first.')
}
export async function setupInput(state: CaseState): Promise<SolverInput> {
  if (state.setup.kind === 'document')
    return parseSolver(
      JSON.parse((await vscode.workspace.openTextDocument(state.setup.uri)).getText()),
    )
  return parseSolver({
    ...state.setup.options,
    system_model_file: portable(relative(setupDirectory(state), state.document.uri.fsPath)),
  })
}
export async function useConfiguration(state: CaseState, uri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri)
  const input = parseSolver(JSON.parse(document.getText()))
  await assertCase(input, dirname(uri.fsPath), state)
  state.setSetup({ kind: 'document', uri })
}
export async function saveConfiguration(state: CaseState): Promise<void> {
  const setup = state.setup
  const version = state.document.version
  const base = setupDirectory(state)
  const configuration =
    setup.kind === 'document' ? await vscode.workspace.openTextDocument(setup.uri) : undefined
  const configurationVersion = configuration?.version
  const input = configuration
    ? parseSolver(JSON.parse(configuration.getText()))
    : await setupInput(state)
  const assertCurrent = () => {
    if (
      state.setup !== setup ||
      state.document.version !== version ||
      configuration?.version !== configurationVersion
    )
      throw new Error('The case or configuration changed. Save the current configuration again.')
  }
  await assertCase(input, base, state)
  const uri = await vscode.window.showSaveDialog({
    title: 'Save Simulation Configuration',
    defaultUri: vscode.Uri.file(
      state.document.uri.fsPath.replace(/\.case\.json$/i, '.solver.json'),
    ),
    filters: { 'Solver configuration': ['solver.json'] },
  })
  if (!uri) return
  assertCurrent()
  if (
    relative(await realpath(base), await realpath(dirname(uri.fsPath))) !== '' &&
    state.raw?.monitors?.some((sink) => sink.file_name && !isAbsolute(sink.file_name))
  )
    throw new Error(
      'Save beside the current configuration: the case has relative monitor filenames that would change destination in another directory.',
    )
  assertCurrent()
  input.system_model_file = portable(relative(dirname(uri.fsPath), state.document.uri.fsPath))
  for (const key of ['output_file', 'reference_file'] as const)
    if (input[key]) input[key] = portable(relative(dirname(uri.fsPath), resolve(base, input[key]!)))
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(input, null, 2) + '\n'))
  state.setSetup({ kind: 'document', uri })
}
export async function prepareSimulation(
  cases: Cases,
  state: ReadyCase,
  root: string,
): Promise<SolverLaunch> {
  const setup = state.setup
  const initialTarget = state.target
  const casePath = await realpath(state.document.uri.fsPath)
  const workspaceRoot = await realpath(root)
  const base = await realpath(setupDirectory(state))
  if (!within(workspaceRoot, casePath) || !within(workspaceRoot, base))
    throw new Error('The case and configuration must be inside the simulation workspace.')
  const configuration =
    setup.kind === 'document' ? await vscode.workspace.openTextDocument(setup.uri) : undefined
  const configurationVersion = configuration?.version
  if (configuration) await assertCase(parseSolver(JSON.parse(configuration.getText())), base, state)
  if (state.setup !== setup || !state.current(initialTarget))
    throw new Error('The case or configuration changed while preparing the simulation. Run again.')
  await cases.edit([
    {
      document: state.document,
      version: state.document.version,
      edits: nativeCaseEdits(state.document.getText(), state.raw),
    },
  ])
  const target = state.target
  const version = state.document.version
  const assertCurrent = () => {
    if (
      state.setup !== setup ||
      !state.current(target) ||
      state.document.version !== version ||
      state.document.isDirty ||
      (configuration && (configuration.version !== configurationVersion || configuration.isDirty))
    )
      throw new Error(
        'The case or configuration changed while preparing the simulation. Run again.',
      )
  }
  if (state.document.isDirty && !(await state.document.save()))
    throw new Error('Save the case before running the simulation.')
  if (configuration?.isDirty && !(await configuration.save()))
    throw new Error('Save the configuration before running the simulation.')
  assertCurrent()
  const verify = (launch: SolverLaunch): SolverLaunch => {
    assertCurrent()
    if (
      launch.sourceText?.case !== state.document.getText() ||
      (configuration && launch.sourceText?.solver !== configuration.getText())
    )
      throw new Error('Saved inputs changed while preparing the simulation. Run again.')
    if (relative(launch.case, casePath) !== '')
      throw new Error('This configuration belongs to a different case. Open that case first.')
    return { ...launch, assertCurrent }
  }
  if (configuration) return verify(await resolveSolver(configuration.uri.fsPath, root, 'staged'))
  const input = await setupInput(state)
  if (!state.raw.monitors?.at(-1)?.file_name)
    input.output_file ??= basename(state.document.uri.fsPath).replace(/\.case\.json$/i, '.mon.csv')
  const path = resolve(base, '.gridkit-' + randomUUID() + '.solver.json')
  const cleanup = async () => {
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  await writeFile(path, JSON.stringify(input), { flag: 'wx' })
  try {
    return { ...verify(await resolveSolver(path, root, 'staged')), cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** Apply a form submission only to the case/configuration it was prepared against. */
export async function commitSetup(
  cases: Cases,
  state: ReadyCase,
  target: CaseTarget,
  setup: SimulationSetup,
  before: SolverInput,
  next: SolverInput,
  caseText = state.document.getText(),
): Promise<void> {
  parseSolver(next)
  const configuration =
    setup.kind === 'document' ? await vscode.workspace.openTextDocument(setup.uri) : undefined
  if (
    !state.current(target) ||
    state.setup !== setup ||
    (configuration &&
      JSON.stringify(parseSolver(JSON.parse(configuration.getText()))) !== JSON.stringify(before))
  )
    throw new Error(
      'The case or configuration changed. Cancel this edit and review the current values.',
    )
  const changes = [
    {
      document: state.document,
      version: state.document.version,
      edits: textEdits(state.document.getText(), caseText),
    },
  ]
  if (configuration) {
    let text = configuration.getText()
    for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
      if (key === 'system_model_file') continue
      const field = key as keyof SolverInput
      if (JSON.stringify(before[field]) !== JSON.stringify(next[field]))
        text = changeJson(text, [key], next[field])
    }
    changes.push({
      document: configuration,
      version: configuration.version,
      edits: textEdits(configuration.getText(), text),
    })
  }
  await cases.edit(changes)
  const { system_model_file: _, ...options } = next
  state.setSetup(setup.kind === 'memory' ? { ...setup, options } : setup)
}
