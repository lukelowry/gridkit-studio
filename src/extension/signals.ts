/** The Monitored Signals view: the signals the case records, from its elements' `mon` lists. A
 *  field's row shows how many elements record it; its menu matches a Case panel column's. */

import * as vscode from 'vscode'

import { fieldDefinition, fieldLabel, tableLabel } from '../shared/document.js'
import { viewId } from '../shared/ids.js'
import { mappingOf, signalContext, TARGET, type Target } from '../shared/menus.js'
import type { Summary } from '../shared/messages.js'
import type { Studio } from './studio.js'

/** A recordable type, or one of its fields when `field` is set. */
class Signal extends vscode.TreeItem {
  [TARGET]?: Target
  constructor(
    readonly type: string,
    readonly field: string | undefined,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsible)
  }
}

/** The types in `summary` that have elements and sampled fields, with those fields. */
function recordable(summary: Summary): { type: string; fields: string[] }[] {
  return summary.definition.tables.flatMap(({ name: type, fields }) => {
    const sampled = fields.filter((field) => field.kind === 'sampled').map((field) => field.name)
    return summary.counts[type] && sampled.length ? [{ type, fields: sampled }] : []
  })
}

const listed = (summary: Summary, type: string, field: string) =>
  summary.recording.listed[type]?.[field] ?? 0

export function registerSignals(studio: Studio) {
  const changed = new vscode.EventEmitter<void>()
  const activeCase = () => {
    const uri = studio.active
    const summary = uri ? studio.state(uri).summary : undefined
    return uri && summary ? { uri, summary, mappings: studio.get(uri)?.mappings ?? {} } : undefined
  }

  const provider: vscode.TreeDataProvider<Signal> = {
    onDidChangeTreeData: changed.event,
    getTreeItem: (item) => item,
    getChildren(parent) {
      const active = activeCase()
      if (!active || parent?.field !== undefined) return []
      const { uri, summary, mappings } = active
      const types = recordable(summary)
      if (!parent)
        return types.map(({ type, fields }) => {
          const name = tableLabel(summary.definition, type)
          const total = summary.counts[type] ?? 0
          const on = fields.filter((field) => listed(summary, type, field) === total).length
          const item = new Signal(type, undefined, name, vscode.TreeItemCollapsibleState.Collapsed)
          item.id = `${uri}\n${type}`
          item.description = `${on}/${fields.length}`
          item.tooltip = `Every ${name} records ${on} of its ${fields.length} signals`
          item.accessibilityInformation = { label: `${name}, ${on} of ${fields.length} recorded` }
          return item
        })
      const { type } = parent
      const name = tableLabel(summary.definition, type)
      const total = summary.counts[type] ?? 0
      return (types.find((each) => each.type === type)?.fields ?? []).map((field) => {
        const count = listed(summary, type, field)
        const label = fieldLabel(fieldDefinition(summary.definition, type, field)!)
        const item = new Signal(type, field, label, vscode.TreeItemCollapsibleState.None)
        item.id = `${uri}\n${type}\n${field}`
        item.description =
          count > 0 && count === total
            ? 'Recorded'
            : count > 0
              ? `${count.toLocaleString()} of ${total.toLocaleString()}`
              : undefined
        item.tooltip = `${name} ${label}`
        item.accessibilityInformation = {
          label: `${name} ${label}, recorded by ${count.toLocaleString()} of ${total.toLocaleString()}`,
        }
        const named = { table: type, field }
        item[TARGET] = { uri, version: summary.version, origin: 'signals', field: named }
        item.contextValue = signalContext({
          recorded: count > 0,
          ...mappingOf(summary, mappings, named),
        })
        return item
      })
    },
  }

  const view = vscode.window.createTreeView(viewId('signals'), {
    treeDataProvider: provider,
    showCollapseAll: true,
  })
  let revision = ''
  /** Redraws when the active case, its version or its mappings change. */
  const refresh = () => {
    const active = activeCase()
    const next = JSON.stringify([active?.uri, active?.summary.version, active?.mappings])
    if (next === revision) return
    revision = next
    view.message =
      active && !recordable(active.summary).length
        ? 'This case has no recordable signals.'
        : undefined
    changed.fire()
  }
  refresh()
  return [changed, view, studio.changed.event(refresh)]
}
