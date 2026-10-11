/** Monitored Signals: what the case's runs record, which is its elements' `mon` lists. A field is
 *  checked when every element of its type lists it. Checking it makes every one list it, and
 *  clearing it makes none, as one edit of the case that undo reverses. */

import * as vscode from 'vscode'

import type { Mutation, Summary } from '../shared/messages.js'
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

/** How many of `type`'s elements list `field`. */
const listed = (summary: Summary, type: string, field: string) =>
  summary.recording.listed[type]?.[field] ?? 0

const checked = (on: boolean) =>
  on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked

type Change = Extract<Mutation, { kind: 'record' }>

export function registerSignals(studio: Sessions) {
  const changed = new vscode.EventEmitter<void>()
  /** The active case and its last parsed summary. */
  const shown = () => {
    const uri = studio.active
    const summary = uri ? studio.state(uri).summary : undefined
    return uri && summary ? { uri, summary } : undefined
  }

  const provider: vscode.TreeDataProvider<Signal> = {
    onDidChangeTreeData: changed.event,
    getTreeItem: (item) => item,
    getChildren(parent) {
      const now = shown()
      if (!now || parent?.field !== undefined) return []
      const { uri, summary } = now
      const types = recordable(summary)
      if (!parent)
        return types.map(({ type, fields }) => {
          const name = typeName(summary.schema, type)
          const total = summary.counts[type] ?? 0
          const on = fields.filter((field) => listed(summary, type, field) === total).length
          const item = new Signal(type, undefined, name, vscode.TreeItemCollapsibleState.Collapsed)
          item.id = `${uri}\n${type}`
          item.description = `${on}/${fields.length}`
          item.tooltip = `${on} of ${fields.length} ${name} values recorded by every ${name}`
          item.accessibilityInformation = { label: `${name}, ${on} of ${fields.length} recorded` }
          return item
        })
      const name = typeName(summary.schema, parent.type)
      const total = summary.counts[parent.type] ?? 0
      const definitions = summary.schema.types[parent.type]?.fields ?? {}
      return (types.find(({ type }) => type === parent.type)?.fields ?? []).map((field) => {
        const count = listed(summary, parent.type, field)
        const label = fieldName(definitions[field], field)
        const item = new Signal(parent.type, field, label, vscode.TreeItemCollapsibleState.None)
        item.id = `${uri}\n${parent.type}\n${field}`
        item.checkboxState = {
          state: checked(count > 0 && count === total),
          accessibilityInformation: { label: `Record ${name} ${label}` },
        }
        // When only some list it, the count says how many, and checking it makes every one.
        if (count > 0 && count < total)
          item.description = `${count.toLocaleString()} of ${total.toLocaleString()}`
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
  /** One edit of the case: each type's elements list `add` and none of `remove`. */
  const record = (changes: readonly Change[], label: string) => {
    const now = shown()
    if (now && changes.length)
      void studio.documents
        .transact(now.uri, now.summary.version, changes, label)
        .catch((error) => studio.report(error))
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
  /** Redraw when the active case or its revision changes. */
  const refresh = () => {
    const now = shown()
    const next = JSON.stringify([now?.uri, now?.summary.version])
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
    studio.command('gridkitStudio.selectAllSignals', every(true)),
    studio.command('gridkitStudio.clearSignals', every(false)),
  ]
}
