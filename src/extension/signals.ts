/** Monitored Signals: a checkbox tree of what future runs record. */

import type { FieldSelection } from '@latkit/model'
import * as vscode from 'vscode'

import type { Summary } from '../shared/messages.js'
import { fieldName, typeName } from '../shared/schema.js'
import type { Sessions } from './sessions.js'

/** A recordable type, or one of its fields when `field` is set. */
class Signal extends vscode.TreeItem {
  constructor(
    readonly type: string,
    readonly field: string | undefined,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsible)
  }
}

/** The types in `summary` with elements and sampled fields, each with those fields. */
function recordable(summary: Summary): { type: string; fields: string[] }[] {
  return Object.entries(summary.schema.types).flatMap(([type, { fields }]) => {
    const sampled = Object.keys(fields).filter((field) => fields[field]!.sampled === true)
    return summary.counts[type] && sampled.length ? [{ type, fields: sampled }] : []
  })
}

/** `outputs` with `type` recording exactly `select`. */
function recording(
  outputs: readonly FieldSelection[],
  type: string,
  select: readonly string[],
): FieldSelection[] {
  const others = outputs.filter(({ from }) => from !== type)
  return select.length ? [...others, { from: type, select: [...select] }] : others
}

const selected = (outputs: readonly FieldSelection[], type: string) =>
  outputs.find(({ from }) => from === type)?.select ?? []

const checked = (on: boolean) =>
  on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked

export function registerSignals(studio: Sessions) {
  const changed = new vscode.EventEmitter<void>()
  /** The active case, its last parsed summary, and what its future runs record. */
  const shown = () => {
    const uri = studio.active
    const summary = uri ? studio.state(uri).summary : undefined
    return uri && summary
      ? { uri, summary, outputs: studio.all.get(uri)?.outputs ?? [] }
      : undefined
  }

  const provider: vscode.TreeDataProvider<Signal> = {
    onDidChangeTreeData: changed.event,
    getTreeItem: (item) => item,
    getChildren(parent) {
      const now = shown()
      if (!now || parent?.field !== undefined) return []
      const { uri, summary, outputs } = now
      const types = recordable(summary)
      if (!parent)
        return types.map(({ type, fields }) => {
          const name = typeName(summary.schema, type)
          const on = selected(outputs, type).length
          const item = new Signal(type, undefined, name, vscode.TreeItemCollapsibleState.Collapsed)
          item.id = `${uri}\n${type}`
          item.description = `${on}/${fields.length}`
          item.checkboxState = {
            state: checked(on === fields.length),
            tooltip: `Record every ${name} value, or none`,
            accessibilityInformation: { label: `Record every ${name} value` },
          }
          item.tooltip = `${on} of ${fields.length} ${name} values recorded`
          item.accessibilityInformation = { label: `${name}, ${on} of ${fields.length} recorded` }
          return item
        })
      const on = selected(outputs, parent.type)
      const name = typeName(summary.schema, parent.type)
      const definitions = summary.schema.types[parent.type]?.fields ?? {}
      return (types.find(({ type }) => type === parent.type)?.fields ?? []).map((field) => {
        const label = fieldName(definitions[field], field)
        const item = new Signal(parent.type, field, label, vscode.TreeItemCollapsibleState.None)
        item.id = `${uri}\n${parent.type}\n${field}`
        item.checkboxState = {
          state: checked(on.includes(field)),
          accessibilityInformation: { label: `Record ${name} ${label}` },
        }
        item.tooltip = definitions[field]?.description ?? `${name} ${label}`
        item.accessibilityInformation = { label: `${name} ${label}` }
        return item
      })
    },
  }

  const view = vscode.window.createTreeView('gridkitStudio.signals', {
    treeDataProvider: provider,
    manageCheckboxStateManually: true,
    showCollapseAll: true,
  })
  view.onDidChangeCheckboxState(({ items }) => {
    const now = shown()
    if (!now) return
    let { outputs } = now
    for (const [item, state] of items) {
      const on = state === vscode.TreeItemCheckboxState.Checked
      const all = recordable(now.summary).find(({ type }) => type === item.type)?.fields ?? []
      const rest = selected(outputs, item.type).filter((field) => field !== item.field)
      const select = item.field === undefined ? (on ? all : []) : on ? [...rest, item.field] : rest
      outputs = recording(outputs, item.type, select)
    }
    studio.record(now.uri, outputs)
  })

  let revision = ''
  /** Redraw when the active case, its revision, its recording, or its error changes. */
  const refresh = () => {
    const now = shown()
    const error = studio.active ? studio.state(studio.active).error : undefined
    const next = JSON.stringify([now?.uri, now?.summary.version, now?.outputs, error])
    if (next === revision) return
    revision = next
    const count = now?.outputs.reduce((n, { select }) => n + select.length, 0) ?? 0
    view.description = now ? `${count} selected` : undefined
    view.message = !now
      ? error
      : recordable(now.summary).length
        ? undefined
        : 'This case has no values a run can record.'
    changed.fire()
  }
  refresh()

  const every = (on: boolean) => () => {
    const now = shown()
    if (now)
      studio.record(
        now.uri,
        on
          ? recordable(now.summary).map(({ type, fields }) => ({ from: type, select: fields }))
          : [],
      )
  }
  return [
    changed,
    view,
    studio.changed.event(refresh),
    vscode.commands.registerCommand('gridkitStudio.selectAllSignals', every(true)),
    vscode.commands.registerCommand('gridkitStudio.clearSignals', every(false)),
  ]
}
