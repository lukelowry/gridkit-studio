import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import * as vscode from 'vscode'

import { Latest } from '../async.js'
import type { Cases, ReadyCase } from '../case.js'
import { describe } from '../errors.js'
import type { SolverInput } from '../gridkit/solver.js'
import type { CaseTarget } from '../targets.js'
import { html } from '../webview/host.js'
import { chooseConfiguration, editEvent } from './commands.js'
import {
  faultDefaults,
  faultDevices,
  faultIntervals,
  faultLabel,
  planFault,
  validateFault,
} from './faults.js'
import { labels } from './labels.js'
import { isRequest, type Request, type ToSimulation } from './messages.js'
import { commitSetup, setupInput, type SimulationSetup } from './setup.js'

export const SIMULATION = 'gridkitStudio.simulation'
interface Snapshot {
  state: ReadyCase
  target: CaseTarget
  setup: SimulationSetup
  input: SolverInput
  revision: number
}
export class SimulationView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView
  private ready = false
  private subscription?: vscode.Disposable
  private readonly subscriptions: vscode.Disposable[] = []
  private readonly reads = new Latest()
  private snapshot?: Snapshot
  private revision = 0
  constructor(
    private readonly cases: Cases,
    private readonly extensionUri: vscode.Uri,
  ) {
    const adopt = () => {
      this.subscription?.dispose()
      this.subscription = cases.active?.onDidChange((kind) => {
        if (kind === 'setup' || kind === 'snapshot' || kind === 'monitoring' || kind === 'results')
          void this.refresh()
      })
      void this.refresh()
    }
    this.subscriptions.push(
      cases.onDidActivate(adopt),
      vscode.workspace.onDidChangeTextDocument(({ document }) => {
        const setup = cases.active?.setup
        if (setup?.kind === 'document' && setup.uri.toString() === document.uri.toString())
          void this.refresh()
      }),
    )
    adopt()
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    this.ready = false
    const receive = view.webview.onDidReceiveMessage((value: unknown) => {
      if (isRequest(value))
        void this.receive(value).catch((error) =>
          this.post({
            type: 'result',
            owner: 'owner' in value ? value.owner : '',
            draftId: 'draftId' in value ? value.draftId : undefined,
            ok: false,
            message: describe(error),
          }),
        )
    })
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh()
    })
    const disposed = view.onDidDispose(() => {
      receive.dispose()
      visibility.dispose()
      disposed.dispose()
      this.ready = false
      this.view = undefined
    })
    view.webview.html = html(
      view.webview,
      this.extensionUri,
      'simulation',
      '<main id="simulation"></main>',
    )
  }
  async addFault(state: ReadyCase, selectedBus?: number): Promise<void> {
    state.assertCommitted()
    if (state.run?.status === 'running')
      throw new Error('Stop the simulation before adding a fault.')
    const target = state.target
    let bus = state.raw.buses.find((bus) => bus.number === selectedBus)
    if (!bus) {
      const choice = await vscode.window.showQuickPick(
        state.raw.buses.map((bus) => ({ label: `Bus ${bus.number}`, description: bus.name, bus })),
        { title: 'Add Fault: Choose Bus', matchOnDescription: true },
      )
      if (!choice) return
      bus = choice.bus
    }
    if (!state.current(target)) return
    this.cases.activate(state)
    await vscode.commands.executeCommand(`${SIMULATION}.focus`)
    await this.refresh()
    const snapshot = this.snapshot
    if (!snapshot || snapshot.state !== state) return
    const value = faultDefaults(bus.number, state.timeline.time, snapshot.input.tmax)
    state.setDraft({
      id: randomUUID(),
      inputIdentity: state.inputKey!,
      setup: snapshot.setup,
      before: snapshot.input,
      value: {
        kind: 'fault',
        bus: bus.number,
        label: `Bus ${bus.number}${bus.name ? ' · ' + bus.name : ''}`,
        values: Object.fromEntries(
          ['start', 'duration', 'resistance', 'reactance'].map((key) => [
            key,
            String(value[key as keyof typeof value]),
          ]),
        ),
      },
    })
    await this.refresh()
  }
  private post(message: ToSimulation): void {
    if (this.ready) void this.view?.webview.postMessage(message)
  }
  private async refresh(): Promise<void> {
    const signal = this.reads.next()
    const state = this.cases.active && this.cases.resolve(this.cases.active.target)
    const base = {
      type: 'state' as const,
      revision: this.revision,
      owner: this.cases.active?.owner ?? '',
      draft: this.cases.active?.simulationDraft
        ? {
            id: this.cases.active.simulationDraft.id,
            value: this.cases.active.simulationDraft.value,
            stale: true,
          }
        : undefined,
      caseName: '',
      configuration: '',
      faults: [],
      events: [],
      running: false,
      notice: '',
    }
    if (!state) {
      this.snapshot = undefined
      this.post(base)
      return
    }
    try {
      const target = state.target
      const setup = state.setup
      const input = await setupInput(state)
      if (signal.aborted || !state.current(target) || state.setup !== setup) return
      const previous = this.snapshot
      if (
        !previous ||
        previous.state !== state ||
        previous.target.revision !== target.revision ||
        previous.setup !== setup ||
        JSON.stringify(previous.input) !== JSON.stringify(input)
      )
        this.revision++
      this.snapshot = { state, target, setup, input, revision: this.revision }
      const devices = faultDevices(state.raw)
      const intervals = faultIntervals(input.events, state.raw)
      const paired = new Set(intervals.flatMap((fault) => [fault.on, fault.off]))
      this.post({
        ...base,
        revision: this.revision,
        draft: state.simulationDraft
          ? {
              id: state.simulationDraft.id,
              value: state.simulationDraft.value,
              stale:
                state.inputKey !== state.simulationDraft.inputIdentity ||
                state.setup !== state.simulationDraft.setup ||
                JSON.stringify(input) !== JSON.stringify(state.simulationDraft.before),
            }
          : undefined,
        caseName: state.fields.model.name,
        configuration:
          setup.kind === 'memory' ? 'Unsaved configuration' : basename(setup.uri.fsPath),
        input,
        faults: intervals.map((interval) => {
          const device = devices[interval.device].device
          return {
            interval,
            label: faultLabel(state.raw, interval.device),
            value: {
              bus: Number(device.ports.bus),
              start: interval.start,
              duration: interval.duration,
              resistance: Number(device.params.R),
              reactance: Number(device.params.X),
            },
          }
        }),
        events: input.events.flatMap((event, index) =>
          paired.has(index)
            ? []
            : [
                {
                  index,
                  label: `${event.time} s · ${event.type.toLowerCase() === 'fault_on' ? 'Apply' : 'Clear'} · ${faultLabel(state.raw, event.element_id)}`,
                },
              ],
        ),
        running: state.run?.status === 'running',
        notice:
          state.run?.error ??
          state.run?.dataError ??
          (state.run?.status === 'running'
            ? state.run.stopping
              ? 'Stopping DynamicSimulation...'
              : 'Running DynamicSimulation...'
            : ''),
      })
    } catch (error) {
      if (!signal.aborted) {
        this.snapshot = undefined
        this.post({ ...base, caseName: state.fields.model.name, notice: describe(error) })
      }
    }
  }
  private async receive(message: Request): Promise<void> {
    if (message.type === 'ready') {
      this.ready = true
      await this.refresh()
      return
    }
    if (message.type === 'focus') {
      this.cases.focus(this.cases.active)
      return
    }
    const state = this.cases.owned(message.owner)
    if (!state) throw new Error('The case is no longer open.')
    if (message.type === 'terminal') {
      await vscode.commands.executeCommand('gridkitStudio.showSolverOutput', state.run)
      return
    }
    if (message.type === 'cancel') {
      if (state.simulationDraft?.id === message.draftId) state.setDraft(undefined)
      this.post({ type: 'result', owner: state.owner, draftId: message.draftId, ok: true })
      await this.refresh()
      return
    }
    if (message.type === 'edit') {
      const previous = state.simulationDraft
      if (previous) {
        if (previous.id !== message.draftId)
          throw new Error('Another Simulation edit is already open.')
        previous.value = message.value
      } else {
        const snapshot = this.snapshot
        if (
          !snapshot ||
          snapshot.state !== state ||
          snapshot.revision !== message.revision ||
          !state.current(snapshot.target)
        )
          throw new Error('The case changed. Review the current values.')
        if (state.run?.status === 'running')
          throw new Error('Stop the simulation before editing its setup.')
        state.setDraft({
          id: message.draftId,
          inputIdentity: state.inputKey!,
          setup: snapshot.setup,
          before: snapshot.input,
          value: message.value,
        })
      }
      return
    }
    const ready = this.cases.resolve(state.target)
    if (!ready) throw new Error('Fix the case errors before applying this edit.')
    if (message.type === 'select') {
      const input = await setupInput(state)
      if (this.snapshot?.state !== state || this.snapshot.revision !== message.revision) return
      const fault = faultIntervals(input.events, ready.raw).find(
        (fault) => fault.on === message.index,
      )
      const bus = fault && faultDevices(ready.raw)[fault.device].device.ports.bus
      const index = ready.raw.buses.findIndex((candidate) => candidate.number === bus)
      if (index >= 0) await this.cases.select(state.target, { element: { classId: 'bus', index } })
      return
    }
    if (state.run?.status === 'running')
      throw new Error('Stop the simulation before editing its setup.')
    if (message.type === 'submit') {
      const draft = state.simulationDraft
      if (!draft || draft.id !== message.draftId)
        throw new Error('This Simulation edit is no longer open.')
      draft.value = message.value
      if (draft.inputIdentity !== state.inputKey)
        throw new Error('The case changed. Cancel this edit and review the current values.')
      const value = message.value
      let next = { ...draft.before }
      let text = state.document.getText()
      if (value.kind === 'settings') {
        for (const [key, text] of Object.entries(value.values)) {
          if (!(key in labels) || key === 'events') throw new Error('Unknown simulation setting.')
          const field = key as keyof SolverInput
          const trimmed = text.trim()
          if (!trimmed) {
            delete next[field]
            continue
          }
          const parsed = [
            'output_file',
            'reference_file',
            'consistent_ic_type',
            'error_type',
          ].includes(key)
            ? trimmed
            : key === 'error_tolerance' && trimmed.includes(',')
              ? trimmed.split(',').map((v) => (v.trim() ? Number(v) : NaN))
              : Number(trimmed)
          Object.assign(next, { [key]: parsed })
        }
      } else {
        const numeric = (key: string) =>
          value.values[key]?.trim() ? Number(value.values[key]) : NaN
        const fault = {
          bus: value.bus,
          start: numeric('start'),
          duration: numeric('duration'),
          resistance: numeric('resistance'),
          reactance: numeric('reactance'),
        }
        const errors = validateFault(fault, draft.before.tmax)
        if (Object.keys(errors).length) throw new Error(Object.values(errors).join(' '))
        const interval =
          value.on === undefined
            ? undefined
            : faultIntervals(next.events, ready.raw).find((fault) => fault.on === value.on)
        if (value.on !== undefined && !interval)
          throw new Error('The fault changed. Review the current setup.')
        const plan = planFault(text, ready.raw, next.events, fault, interval)
        next = { ...next, events: plan.events }
        text = plan.text
      }
      await commitSetup(this.cases, ready, state.target, draft.setup, draft.before, next, text)
      if (state.simulationDraft?.id === draft.id) state.setDraft(undefined)
      this.post({ type: 'result', owner: state.owner, draftId: draft.id, ok: true })
    } else {
      state.assertCommitted()
      if (message.type === 'configuration') await chooseConfiguration(state)
      else {
        const snapshot = this.snapshot
        if (
          !snapshot ||
          snapshot.state !== state ||
          snapshot.revision !== message.revision ||
          !state.current(snapshot.target)
        )
          throw new Error('The configuration changed. Review the current values.')
        if (message.type === 'editEvent')
          await editEvent(this.cases, ready, () => this.addFault(ready), message.index)
        else {
          const { input, setup, target } = snapshot
          const interval =
            message.type === 'removeFault'
              ? faultIntervals(input.events, ready.raw).find((fault) => fault.on === message.index)
              : undefined
          if (message.type === 'removeFault' && !interval)
            throw new Error('The fault no longer exists.')
          const remove = new Set(interval ? [interval.on, interval.off] : [message.index])
          await commitSetup(this.cases, ready, target, setup, input, {
            ...input,
            events: input.events.filter((_, i) => !remove.has(i)),
          })
        }
      }
      this.post({ type: 'result', owner: state.owner, ok: true })
    }
    await this.refresh()
  }
  dispose(): void {
    this.reads.abort()
    this.subscription?.dispose()
    for (const subscription of this.subscriptions) subscription.dispose()
  }
}
