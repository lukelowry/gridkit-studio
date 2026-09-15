import { fieldKey, type FieldRef } from '@latkit/model'
import { CHANNELS } from '@latkit/network'
import * as vscode from 'vscode'

import { channelsFor, DISPLAY_CHANNELS, isDisplayChannel } from './bindings.js'
import type { Cases, ReadyCase } from './case.js'
import { caseCommand } from './commands.js'
import { locate } from './gridkit/source.js'
import type { MonitorView } from './monitor/view.js'
import type { NetworkEditor } from './network/editor.js'
import { tableFieldId } from './table/columns.js'
import type { CaseTable } from './table/view.js'
import { record, type Target } from './targets.js'

export async function showSource(cases: Cases, target: Target): Promise<void> {
  const state = cases.resolve(target)
  if (!state) return
  const document = state.document
  let span = target.element ? cases.documents.source(document, target.element) : undefined
  if (
    span &&
    target.field?.source === 'column' &&
    target.field.classId === target.element?.classId
  ) {
    const dot = target.field.id.indexOf('.')
    const block = target.field.id.slice(0, dot)
    const key = target.field.id.slice(dot + 1)
    const found = locate(
      document.getText().slice(span.offset, span.offset + span.length),
      block === 'top' ? [key] : [block, key],
    )
    span = { offset: span.offset + found.offset, length: found.length }
  }
  const column = vscode.window.visibleTextEditors.find(
    (editor) => editor.document === document,
  )?.viewColumn
  const editor = await vscode.window.showTextDocument(document, {
    viewColumn: column ?? vscode.ViewColumn.Beside,
    preview: false,
  })
  if (!span || !state.current(target)) return
  editor.selection = new vscode.Selection(
    document.positionAt(span.offset),
    document.positionAt(span.offset + span.length),
  )
  editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}

const argumentChannel = (argument: unknown) =>
  record(argument) && isDisplayChannel(argument.channel) ? argument.channel : undefined

export function registerActions(
  context: vscode.ExtensionContext,
  cases: Cases,
  network: NetworkEditor,
  table: CaseTable,
  monitor?: MonitorView,
): void {
  const command = (
    name: string,
    action: (state: ReadyCase, target: Target, argument: unknown) => unknown,
  ) => caseCommand(context, cases, name, action)
  command('plot', (state, target) => monitor?.show(state, target))
  command('elementSource', (_, target) => showSource(cases, target))
  command('inspectField', (state, target) =>
    table.show(
      state,
      target.field?.classId ?? target.element?.classId,
      target.field ? tableFieldId(target.field) : undefined,
    ),
  )
  command('showInTable', async (state, target) => {
    if (target.element) await cases.select(target, { element: target.element, field: target.field })
    await table.show(state, target.element?.classId)
  })
  command('reveal', async (state, target) => {
    if (!target.element) return
    await cases.select(target, { element: target.element, field: target.field })
    if (state.current(target)) await network.show(state)
  })
  command('neighborhood', async (state, target) => {
    if (!target.element) return
    await cases.select(target, { element: target.element, field: target.field })
    if (!state.current(target)) return
    await network.show(state)
    if (state.current(target)) network.reveal(state, target.element, true)
  })
  command('copyIdentifier', async (state, target) => {
    if (!target.element) return
    const data = await state.fields.model.load(target.element.classId, state.signal)
    if (state.current(target))
      await vscode.env.clipboard.writeText(data.labels[target.element.index])
  })
  command('copyValue', async (state, target) => {
    if (!target.element || !target.field) return
    const column =
      target.field.source === 'signal'
        ? await state.fields.column(target.field, state.signal)
        : await state.fields.field(target.field, state.signal)
    if (!state.current(target) || !('values' in column)) return
    const value = column.values[target.element.index]
    await vscode.env.clipboard.writeText(
      value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))
        ? ''
        : String(value),
    )
  })
  command('copyReference', async (_, target) => {
    const element = target.element
      ? `${target.element.classId}[${target.element.index}]`
      : undefined
    const value = target.field
      ? `${element ?? target.field.classId}:${target.field.source}:${target.field.id}`
      : element
    if (value) await vscode.env.clipboard.writeText(value)
  })
  command('chooseOverlapping', async (state, target) => {
    const refs = target.items?.filter((ref) => state.has(ref)) ?? []
    const choice = await vscode.window.showQuickPick(
      refs.map((ref) => ({ label: `${ref.classId}[${ref.index}]`, ref })),
      { title: 'Overlapping network elements' },
    )
    if (choice && state.current(target)) await cases.select(target, { element: choice.ref })
  })
  for (const endpoint of [0, 1] as const)
    command(endpoint === 0 ? 'fromEndpoint' : 'toEndpoint', async (state, target) => {
      const model = state.fields.model
      if (!target.element || target.element.classId !== model.owners.edge || !model.owners.vertex)
        return
      const ref = {
        classId: model.owners.vertex,
        index: model.topology.edges[target.element.index * 2 + endpoint],
      }
      await cases.select(target, { element: ref })
    })
  command('bind', async (state, target, argument) => {
    const fixedChannel = argumentChannel(argument)
    let field: FieldRef | undefined = fixedChannel ? undefined : target.field
    if (!field) {
      const classIds = fixedChannel
        ? [state.fields.model.owners[CHANNELS[fixedChannel].scope]].filter(
            (id): id is string => !!id,
          )
        : [target.element?.classId].filter((id): id is string => !!id)
      const choices = (
        await Promise.all(
          classIds.map((id) =>
            state.fields
              .list(id, state.signal)
              .then((fields) => [
                ...fields.filter((field) => field.source === 'column'),
                ...state.fields.signals(id),
              ]),
          ),
        )
      ).flat()
      if (!state.current(target)) return
      const choice = await vscode.window.showQuickPick(
        choices.map((field) => ({
          label: field.label,
          description: `${field.classId}.${field.id}`,
          field,
        })),
        { title: 'Field or Signal', matchOnDescription: true },
      )
      if (!choice || !state.current(target)) return
      field = choice.field
    }
    const available = channelsFor(state.fields.model, field)
    const choice = fixedChannel
      ? { channel: fixedChannel }
      : await vscode.window.showQuickPick(
          available.map((channel) => {
            const current = state.bindings[channel]
            return {
              channel,
              label: CHANNELS[channel].label,
              description: current
                ? fieldKey(current.field) === fieldKey(field!)
                  ? 'Current binding'
                  : `${current.field.classId}.${current.field.id}`
                : 'Unbound',
            }
          }),
          { title: `Bind ${field.id}` },
        )
    if (!choice || !state.current(target)) return
    await state.bind(target, choice.channel, { field })
  })
  command('unbind', async (state, target, argument) => {
    const channel = argumentChannel(argument)
    const keys = (channel ? [channel] : DISPLAY_CHANNELS).filter((key) => {
      const binding = state.bindings[key]
      return (
        binding &&
        (channel ||
          (target.field
            ? fieldKey(target.field) === fieldKey(binding.field)
            : binding.field.classId === target.element?.classId))
      )
    })
    const selected =
      keys.length < 2
        ? keys
        : (
            await vscode.window.showQuickPick(
              keys.map((key) => ({ label: CHANNELS[key].label, key })),
              { title: 'Unbind from network', canPickMany: true },
            )
          )?.map((item) => item.key)
    if (!selected || !state.current(target)) return
    for (const key of selected) await state.bind(target, key, null)
  })
  command('bindingRange', async (state, target, argument) => {
    const channel = argumentChannel(argument)
    if (!channel || !CHANNELS[channel].normalized) return
    if (channel === 'vertexColor' || channel === 'edgeColor') {
      await vscode.commands.executeCommand('gridkitStudio.signalRange', {
        ...target,
        field: state.bindings[channel]?.field,
      })
      return
    }
    const binding = state.bindings[channel]
    if (!binding) return
    const value = await vscode.window.showInputBox({
      title: `${CHANNELS[channel].label} input range`,
      prompt: 'Two increasing numbers, separated by a comma. Leave empty for automatic range.',
      value: binding.range?.join(', ') ?? '',
      validateInput: (text) => {
        const values = text.split(',').map(Number)
        return !text.trim() ||
          (values.length === 2 && values.every(Number.isFinite) && values[0] < values[1])
          ? undefined
          : 'Enter two finite, increasing numbers.'
      },
    })
    if (value === undefined || !state.current(target) || state.bindings[channel] !== binding) return
    await state.bind(target, channel, {
      field: binding.field,
      ...(value.trim() && { range: value.split(',').map(Number) as [number, number] }),
    })
  })
}
