import { dirname, resolve } from 'node:path'

import * as vscode from 'vscode'

import type { Cases, CaseState, ReadyCase } from '../case.js'
import { caseCommand, command } from '../commands.js'
import {
  commitSetup,
  saveConfiguration,
  setupDirectory,
  setupInput,
  SOLVER_EXCLUDES,
  SOLVER_FILES,
  useConfiguration,
} from './setup.js'
import type { SimulationView } from './view.js'

export function registerSimulationCommands(
  context: vscode.ExtensionContext,
  cases: Cases,
  view: SimulationView,
): void {
  caseCommand(context, cases, 'addFault', async (state, target) => {
    const element = target.element ?? state.selection?.element
    await view.addFault(
      state,
      element?.classId === 'bus' ? state.raw.buses[element.index]?.number : undefined,
    )
  })
  const active = (id: string, action: (state: CaseState) => unknown) =>
    command(context, id, () => {
      const state = cases.active
      if (!state) return
      state.assertCommitted()
      return action(state)
    })
  active('chooseConfiguration', chooseConfiguration)
  active('saveConfiguration', saveConfiguration)
  command(context, 'openConfiguration', () => {
    const setup = cases.active?.setup
    if (setup?.kind === 'document') return vscode.window.showTextDocument(setup.uri)
  })
  caseCommand(context, cases, 'addEvent', async (state) => {
    state.assertCommitted()
    await editEvent(cases, state, () => view.addFault(state))
  })
}

export async function chooseConfiguration(state: CaseState): Promise<void> {
  const candidates = await vscode.workspace.findFiles(SOLVER_FILES, SOLVER_EXCLUDES)
  const files: vscode.Uri[] = []
  for (const uri of candidates) {
    try {
      const value = JSON.parse((await vscode.workspace.openTextDocument(uri)).getText())
      if (
        typeof value.system_model_file === 'string' &&
        resolve(dirname(uri.fsPath), value.system_model_file) === resolve(state.document.uri.fsPath)
      )
        files.push(uri)
    } catch {
      /* Invalid configurations remain available in the JSON editor. */
    }
  }
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'In memory', uri: undefined },
      ...files.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
    ],
    { title: 'Simulation Configuration' },
  )
  if (!choice || state.disposed) return
  if (choice.uri) await useConfiguration(state, choice.uri)
  else {
    const setup = state.setup
    const baseDirectory = setupDirectory(state)
    const { system_model_file: _, ...options } = await setupInput(state)
    if (state.setup !== setup) throw new Error('The configuration changed. Choose it again.')
    state.setSetup({ kind: 'memory', options, baseDirectory })
  }
}

export async function editEvent(
  cases: Cases,
  state: ReadyCase,
  addFault: () => Promise<void>,
  index?: number,
): Promise<void> {
  const target = state.target
  const setup = state.setup
  const input = await setupInput(state)
  const previous = index === undefined ? undefined : input.events[index]
  const faults = state.raw.devices.filter((device) => device.class === 'BusFault')
  if (!faults.length) {
    await addFault()
    return
  }
  const fault = await vscode.window.showQuickPick(
    faults.map((device, index) => ({
      index,
      label: `BusFault ${device.id}`,
      description: `Bus ${device.ports.bus}`,
      device,
      picked: index === previous?.element_id,
    })),
    { title: 'Event Fault Device' },
  )
  if (!fault) return
  const type = await vscode.window.showQuickPick(
    [
      { label: 'Apply fault', value: 'fault_on' },
      { label: 'Clear fault', value: 'fault_off' },
    ],
    { title: 'Event Operation' },
  )
  if (!type) return
  const text = await vscode.window.showInputBox({
    title: 'Event Time (s)',
    value: String(previous?.time ?? 0),
    validateInput: (value) =>
      value.trim() &&
      Number.isFinite(Number(value)) &&
      Number(value) >= 0 &&
      Number(value) <= input.tmax
        ? undefined
        : `Enter a time from 0 to ${input.tmax}.`,
  })
  if (text === undefined) return
  const events = input.events.filter((_, at) => at !== index)
  events.push({ time: Number(text), type: type.value, element_id: fault.index })
  events.sort((a, b) => a.time - b.time)
  await commitSetup(cases, state, target, setup, input, { ...input, events })
}
