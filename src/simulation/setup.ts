import { randomUUID } from 'node:crypto'
import { realpath, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'

import * as vscode from 'vscode'

import type { Cases, CaseState, ReadyCase } from '../case.js'
import { changeJson, faultRealEdits, textEdits } from '../gridkit/edit.js'
import { parseSolver, type SolverInput, type SolverOptions } from '../gridkit/solver.js'
import { resolveSolver, type SolverLaunch, within } from '../launch.js'
import type { CaseTarget } from '../targets.js'
import type { DraftValue } from './messages.js'

export type SimulationSetup =
  { kind: 'memory'; options: SolverOptions } | { kind: 'document'; uri: vscode.Uri }
export interface SimulationDraft {
  id: string
  inputIdentity: string
  setup: SimulationSetup
  before: SolverInput
  value: DraftValue
}
export const SOLVER_FILES = '**/*.solver.json'
/** Temporary inputs written beside a case for in-memory setups are never offered as files. */
export const SOLVER_EXCLUDES = '{**/node_modules/**,**/.git/**,**/.gridkit-*}'
export const portable = (path: string) => path.split('\\').join('/')

export async function setupInput(state: CaseState): Promise<SolverInput> {
  if (state.setup.kind === 'document')
    return parseSolver(
      JSON.parse((await vscode.workspace.openTextDocument(state.setup.uri)).getText()),
    )
  return parseSolver({
    ...state.setup.options,
    system_model_file: basename(state.document.uri.fsPath),
  })
}
export async function useConfiguration(state: CaseState, uri: vscode.Uri): Promise<void> {
  const document = await vscode.workspace.openTextDocument(uri)
  const input = parseSolver(JSON.parse(document.getText()))
  if (resolve(dirname(uri.fsPath), input.system_model_file) !== resolve(state.document.uri.fsPath))
    throw new Error('This configuration belongs to a different case. Open that case first.')
  state.setSetup({ kind: 'document', uri })
}
export async function saveConfiguration(state: CaseState): Promise<void> {
  const input = await setupInput(state)
  const uri = await vscode.window.showSaveDialog({
    title: 'Save Simulation Configuration',
    defaultUri: vscode.Uri.file(
      state.document.uri.fsPath.replace(/\.case\.json$/i, '.solver.json'),
    ),
    filters: { 'Solver configuration': ['solver.json'] },
  })
  if (!uri) return
  const base = dirname(
    state.setup.kind === 'document' ? state.setup.uri.fsPath : state.document.uri.fsPath,
  )
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
  const casePath = await realpath(state.document.uri.fsPath)
  const workspaceRoot = await realpath(root)
  if (!within(workspaceRoot, casePath))
    throw new Error('The case must be inside the simulation workspace.')
  await cases.edit([
    {
      document: state.document,
      version: state.document.version,
      edits: faultRealEdits(state.document.getText(), state.raw),
    },
  ])
  if (state.document.isDirty && !(await state.document.save()))
    throw new Error('Save the case before running the simulation.')
  if (state.setup.kind === 'document') {
    const document = await vscode.workspace.openTextDocument(state.setup.uri)
    if (document.isDirty && !(await document.save()))
      throw new Error('Save the configuration before running the simulation.')
    return resolveSolver(document.uri.fsPath, root)
  }
  const input = await setupInput(state)
  if (!state.raw.monitors?.some((sink) => sink.file_name))
    input.output_file ??= basename(state.document.uri.fsPath).replace(/\.case\.json$/i, '.mon.csv')
  const path = resolve(dirname(state.document.uri.fsPath), `.gridkit-${randomUUID()}.solver.json`)
  const cleanup = async () => {
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  await writeFile(path, JSON.stringify(input), { flag: 'wx' })
  try {
    return { ...(await resolveSolver(path, root)), cleanup }
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
  state.setSetup(setup.kind === 'memory' ? { kind: 'memory', options } : setup)
}
