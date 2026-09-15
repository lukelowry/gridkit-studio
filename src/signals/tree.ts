import { fieldKey } from '@latkit/model'
import { CHANNELS } from '@latkit/network'
import * as vscode from 'vscode'

import { channelsFor, DISPLAY_CHANNELS, type DisplayChannel } from '../bindings.js'
import type { CaseState } from '../case.js'
import type { Cases, ReadyCase } from '../case.js'
import { caseCommand, report } from '../commands.js'
import { signalStatus } from '../fields.js'
import { canonicalMonitor } from '../gridkit/classes.js'
import type { Target } from '../targets.js'
import type { MonitoringChange } from './edits.js'
import { monitored, setElementSignals, setSignalElements, signalElements } from './edits.js'

export const SIGNALS = 'gridkitStudio.signals'
class SignalItem extends vscode.TreeItem {
  constructor(
    label: string,
    readonly target: Target,
    readonly kind: 'bindings' | 'class' | 'signal' | 'channel',
    readonly classId?: string,
    readonly channel?: DisplayChannel,
    readonly owner?: CaseState,
    readonly inputKey?: string,
  ) {
    super(
      label,
      kind === 'bindings' || kind === 'class'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    )
  }
}
export class SignalsTree implements vscode.TreeDataProvider<SignalItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SignalItem | undefined>()
  readonly onDidChangeTreeData = this.changed.event
  private readonly subscriptions: vscode.Disposable[] = []
  private subscription?: vscode.Disposable
  private readonly view: vscode.TreeView<SignalItem>
  constructor(
    private readonly cases: Cases,
    context: vscode.ExtensionContext,
  ) {
    this.view = vscode.window.createTreeView(SIGNALS, {
      treeDataProvider: this,
      showCollapseAll: true,
      manageCheckboxStateManually: true,
    })
    const refresh = () => {
      this.view.description = cases.active?.fields?.model.name
      this.changed.fire(undefined)
    }
    const adopt = () => {
      this.subscription?.dispose()
      this.subscription = cases.active?.onDidChange((kind) => {
        if (!['selection', 'time', 'pending', 'draft'].includes(kind)) refresh()
      })
      refresh()
    }
    this.subscriptions.push(
      cases.onDidActivate(adopt),
      this.view.onDidChangeCheckboxState(async (event) => {
        try {
          const batches = new Map<CaseState, { inputKey: string; changes: MonitoringChange[] }>()
          for (const [item, checked] of event.items) {
            const state = item.owner
            const field = item.target.field
            if (!state || !field || !item.inputKey) continue
            const count =
              state.fields?.model.classes.find((cls) => cls.id === field.classId)?.count ?? 0
            const batch = batches.get(state) ?? { inputKey: item.inputKey, changes: [] }
            batch.changes.push({
              field,
              elements: Array.from({ length: count }, (_, i) => i),
              enabled: checked === vscode.TreeItemCheckboxState.Checked,
            })
            batches.set(state, batch)
          }
          for (const [state, batch] of batches)
            await state.updateMonitoring(cases, batch.inputKey, batch.changes)
        } catch (error) {
          report(error)
        } finally {
          refresh()
        }
      }),
    )
    caseCommand(context, cases, 'signalElements', (state, target) => this.elements(state, target))
    caseCommand(context, cases, 'monitorSignals', (state, target) => this.signals(state, target))
    caseCommand(context, cases, 'findSignal', async (state) => {
      const fields = state.fields.model.classes.flatMap((cls) => state.fields.signals(cls.id))
      const choice = await vscode.window.showQuickPick(
        fields.map((field) => ({ label: field.label, description: field.classId, field })),
        { title: 'Find Signal', matchOnDescription: true },
      )
      if (choice && !state.disposed)
        await this.elements(state, { ...state.target, field: choice.field })
    })
    adopt()
  }
  getTreeItem(item: SignalItem): vscode.TreeItem {
    return item
  }
  getChildren(parent?: SignalItem): SignalItem[] {
    const active = this.cases.active
    const state = active && this.cases.resolve(active.target)
    if (!state || (parent && !state.current(parent.target))) return []
    const { fields } = state
    const target = state.target
    if (!parent)
      return [
        new SignalItem('Network bindings', target, 'bindings'),
        ...fields.model.classes
          .filter((cls) => state.fields.signals(cls.id).length)
          .map((cls) => {
            const item = new SignalItem(cls.label, target, 'class', cls.id)
            item.description = `${cls.count} ${cls.count === 1 ? 'element' : 'elements'}`
            item.id = `${target.uri}:${cls.id}`
            return item
          }),
      ]
    if (parent.kind === 'bindings')
      return DISPLAY_CHANNELS.map((channel) => {
        const binding = state.bindings[channel]
        const item = new SignalItem(
          CHANNELS[channel].label,
          { ...target, field: binding?.field },
          'channel',
          undefined,
          channel,
        )
        item.description = binding ? `${binding.field.classId}.${binding.field.id}` : 'Unbound'
        if (binding?.field.source === 'signal')
          item.description += ` / ${signalStatus(state.signalState(binding.field))}`
        if (binding && CHANNELS[channel].normalized) {
          const range =
            CHANNELS[channel].map === 'colormap'
              ? state.display.scales.get(fieldKey(binding.field))
              : binding.range
          item.tooltip = `${binding.field.classId}.${binding.field.id}\n${range ? `Range: ${range.join(' to ')}` : 'Automatic range'}`
        }
        item.contextValue = binding
          ? CHANNELS[channel].normalized
            ? 'signalBindingRange'
            : 'signalBinding'
          : 'signalChannel'
        item.iconPath = new vscode.ThemeIcon(binding ? 'link' : 'circle-outline')
        item.command = {
          command: 'gridkitStudio.bind',
          title: 'Bind to Network',
          arguments: [item],
        }
        return item
      })
    if (parent.kind !== 'class' || !parent.classId) return []
    const count = signalElements(state.raw, parent.classId).length
    return fields.signals(parent.classId).map((field) => {
      const status = state.signalState(field)
      const selected = status.monitored
      const bound = DISPLAY_CHANNELS.filter(
        (channel) =>
          state.bindings[channel] && fieldKey(state.bindings[channel]!.field) === fieldKey(field),
      )
      const item = new SignalItem(
        field.label,
        { ...target, field },
        'signal',
        undefined,
        undefined,
        state,
        state.inputKey,
      )
      item.id = `${target.uri}:${fieldKey(field)}`
      item.checkboxState = {
        state:
          selected === count
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked,
        tooltip:
          selected && selected < count
            ? `${selected} of ${count}. Check to monitor all; Choose Elements to edit the subset.`
            : 'Include this signal in subsequent simulations.',
      }
      const coverage =
        selected === count ? `All ${count}` : selected ? `${selected} of ${count}` : 'None'
      item.description = bound.length
        ? `${coverage} / ${bound.map((channel) => CHANNELS[channel].label).join(', ')}`
        : `${coverage} / ${signalStatus(status)}`
      item.contextValue = channelsFor(fields.model, field).length
        ? 'bindableSignal'
        : 'monitorSignal'
      item.tooltip = `${field.classId}.${field.id}${field.unit ? ` (${field.unit})` : ''}\nMonitoring changes apply to the next simulation. Existing samples remain available.\n${signalStatus(status)}`
      item.command = { command: 'gridkitStudio.plot', title: 'Plot', arguments: [item] }
      return item
    })
  }
  private async elements(state: ReadyCase, target: Target): Promise<void> {
    const field = target.field
    if (!field || field.source !== 'signal') return
    const data = await state.fields.model.load(field.classId)
    const selected = new Set(monitored(state.raw, field))
    const choices = await vscode.window.showQuickPick(
      data.labels.map((label, index) => ({ label, index, picked: selected.has(index) })),
      { title: `Monitor ${field.classId}.${field.id} on Elements`, canPickMany: true },
    )
    if (choices && state.current(target))
      await setSignalElements(
        this.cases,
        state,
        field,
        choices.map((choice) => choice.index),
      )
  }
  private async signals(state: ReadyCase, target: Target): Promise<void> {
    let id = target.element?.classId ?? target.field?.classId
    if (!id)
      id = (
        await vscode.window.showQuickPick(
          state.fields.model.classes
            .filter((cls) => state.fields.signals(cls.id).length)
            .map((cls) => ({ label: cls.label, id: cls.id })),
          { title: 'Monitor Signals for Class' },
        )
      )?.id
    if (!id || !state.current(target)) return
    const elements = signalElements(state.raw, id)
    const indices = target.element ? [target.element.index] : elements.map((_, index) => index)
    const fields = state.fields.signals(id)
    const choices = await vscode.window.showQuickPick(
      fields.map((field) => ({
        label: field.label,
        field,
        picked: indices.every((index) =>
          elements[index].mon?.some(
            (name) => canonicalMonitor(elements[index].class, name) === field.id,
          ),
        ),
      })),
      {
        title: target.element
          ? `Monitor Signals for ${id}[${target.element.index}]`
          : `Monitor Signals for All ${id}`,
        canPickMany: true,
      },
    )
    if (!choices || !state.current(target)) return
    const mon = choices.map((choice) => choice.field.id)
    await setElementSignals(this.cases, state, id, new Map(indices.map((index) => [index, mon])))
  }
  dispose(): void {
    this.subscription?.dispose()
    this.subscriptions.forEach((item) => item.dispose())
    this.view.dispose()
    this.changed.dispose()
  }
}
