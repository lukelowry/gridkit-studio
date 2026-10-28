/** Monitored Signals: what the case's runs record, which is its elements' `mon` lists. A field is
 *  checked when every element of its type lists it. Checking it makes every one list it, and
 *  clearing it makes none, as one edit of the case that undo reverses. A field's menu acts on it as
 *  a Case panel column's does: it plots and maps it. */

import * as vscode from 'vscode'

import { channelsOf, NUMERIC } from '../shared/bindings.js'
import { signalContext, type Target } from '../shared/contexts.js'
import { fieldDefinition, fieldLabel, networkRole, tableLabel } from '../shared/document.js'
import { viewId } from '../shared/ids.js'
import type { Mutation, Summary } from '../shared/messages.js'
import type { Sessions } from './sessions.js'

/** A recordable type, or one of its fields when `field` is set, which its menu's commands act on
 *  through `gridkitTarget`. */
class Signal extends vscode.TreeItem {
  gridkitTarget?: Target
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
  return summary.definition.tables.flatMap(({ name: type, fields }) => {
    const sampled = fields.filter((field) => field.kind === 'sampled').map((field) => field.name)
    return summary.counts[type] && sampled.length ? [{ type, fields: sampled }] : []
  })
}

/** How many of `type`'s elements list `field`. */
const listed = (summary: Summary, type: string, field: string) =>
  summary.recording.listed[type]?.[field] ?? 0

const checked = (on: boolean) =>
  on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked

type Change = Extract<Mutation, { kind: 'record' }>

export function registerSignals(studio: Sessions) {
  const changed = new vscode.EventEmitter<void>()
  /** The active case, its last parsed summary, and what it maps. */
  const shown = () => {
    const uri = studio.active
    const summary = uri ? studio.state(uri).summary : undefined
    return uri && summary ? { uri, summary, bindings: studio.get(uri)?.bindings ?? {} } : undefined
  }

  const provider: vscode.TreeDataProvider<Signal> = {
    onDidChangeTreeData: changed.event,
    getTreeItem: (item) => item,
    getChildren(parent) {
      const now = shown()
      if (!now || parent?.field !== undefined) return []
      const { uri, summary, bindings } = now
      const types = recordable(summary)
      if (!parent)
        return types.map(({ type, fields }) => {
          const name = tableLabel(summary.definition, type)
          const total = summary.counts[type] ?? 0
          const on = fields.filter((field) => listed(summary, type, field) === total).length
          const item = new Signal(type, undefined, name, vscode.TreeItemCollapsibleState.Collapsed)
          item.id = `${uri}\n${type}`
          item.description = `${on}/${fields.length}`
          item.tooltip = `${on} of ${fields.length} ${name} values recorded by every ${name}`
          item.accessibilityInformation = { label: `${name}, ${on} of ${fields.length} recorded` }
          return item
        })
      const { type } = parent
      const name = tableLabel(summary.definition, type)
      const total = summary.counts[type] ?? 0
      const drawn = !!networkRole(summary.definition, type)
      return (types.find((each) => each.type === type)?.fields ?? []).map((field) => {
        const count = listed(summary, type, field)
        const label = fieldLabel(fieldDefinition(summary.definition, type, field)!)
        const item = new Signal(type, field, label, vscode.TreeItemCollapsibleState.None)
        item.id = `${uri}\n${type}\n${field}`
        item.checkboxState = {
          state: checked(count > 0 && count === total),
          accessibilityInformation: { label: `Record ${name} ${label}` },
        }
        // When only some list it, the count says how many, and checking it makes every one.
        if (count > 0 && count < total)
          item.description = `${count.toLocaleString()} of ${total.toLocaleString()}`
        item.tooltip = `${name} ${label}`
        item.accessibilityInformation = { label: `${name} ${label}` }
        item.gridkitTarget = { uri, version: summary.version, origin: 'signals', type, field }
        item.contextValue = signalContext({
          recorded: count > 0,
          mappable: drawn && NUMERIC.has(fieldDefinition(summary.definition, type, field)?.kind),
          mapped: channelsOf(bindings, { table: type, field }).length > 0,
        })
        return item
      })
    },
  }

  const view = vscode.window.createTreeView(viewId('signals'), {
    treeDataProvider: provider,
    manageCheckboxStateManually: true,
    showCollapseAll: true,
  })
  studio.signalRow = (type, field) =>
    (
      provider.getChildren(
        new Signal(type, undefined, '', vscode.TreeItemCollapsibleState.Collapsed),
      ) as Signal[]
    ).find((item) => item.field === field)
  /** One edit of the case: each type's elements list `add` and none of `remove`. What they list
   *  means the same in any revision, so the edit waits for the last and applies to it: boxes
   *  checked quickly, each before the case is read again, all take. */
  const record = (changes: readonly Change[], label: string) => {
    const now = shown()
    if (now && changes.length)
      void studio.documents
        .transact(now.uri, 'latest', changes, label)
        .catch((error) => studio.reporter.report(error))
  }
  view.onDidChangeCheckboxState(({ items }) => {
    const changes = new Map<
      string,
      { kind: 'record'; type: string; add: string[]; remove: string[] }
    >()
    for (const [{ type, field }, state] of items) {
      if (field === undefined) continue
      const change = changes.get(type) ?? { kind: 'record' as const, type, add: [], remove: [] }
      changes.set(type, change)
      if (state === vscode.TreeItemCheckboxState.Checked) change.add.push(field)
      else change.remove.push(field)
    }
    record([...changes.values()], 'Change recorded signals')
  })

  let revision = ''
  /** Redraw when the active case, its revision, or what it maps changes: a mapping changes what a
   *  field's menu offers. */
  const refresh = () => {
    const now = shown()
    const next = JSON.stringify([now?.uri, now?.summary.version, now?.bindings])
    if (next === revision) return
    revision = next
    view.message =
      now && !recordable(now.summary).length ? 'This case has no recordable signals.' : undefined
    changed.fire()
  }
  refresh()

  const every = (on: boolean) => () => {
    const now = shown()
    if (now)
      record(
        recordable(now.summary).map(({ type, fields }) => ({
          kind: 'record',
          type,
          add: on ? fields : [],
          remove: on ? [] : fields,
        })),
        on ? 'Record all signals' : 'Record no signals',
      )
  }
  return [
    changed,
    view,
    studio.changed.event(refresh),
    studio.command('recordAllSignals', every(true)),
    studio.command('recordNoSignals', every(false)),
  ]
}
