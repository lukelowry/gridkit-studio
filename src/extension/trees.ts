import type { RowsBlock, RowsQuery } from '@latkit/model'
import * as vscode from 'vscode'

import { display, referenceNames, rowsOf } from '../shared/cells.js'
import { menuContext, type Target } from '../shared/contexts.js'
import type { Sessions } from './sessions.js'

/** A field of the selected element, as the Inspector lists it. */
export class Node extends vscode.TreeItem {
  target?: Target
}

/** The Inspector: the selected element's fields, each with the native actions of its kind. */
export function registerTrees(studio: Sessions) {
  const changed = new vscode.EventEmitter<Node | undefined>()
  let revision = ''
  const refresh = studio.changed.event(() => {
    const state = studio.active ? studio.state(studio.active) : undefined
    const next = [
      studio.active,
      state?.summary?.version,
      state?.stale,
      state?.selection?.id,
      JSON.stringify(state?.bindings),
    ].join(':')
    if (next !== revision) {
      revision = next
      changed.fire(undefined)
    }
  })
  const provider: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: changed.event,
    getTreeItem: (node) => node,
    async getChildren(node) {
      if (node || !studio.active) return []
      const state = studio.state(studio.active)
      const { summary, selection } = state
      if (!summary) return []
      if (!selection) return [new Node('Select an element in Network, Diagram, Case, or JSON.')]
      const type = selection.id.slice(0, selection.id.indexOf('/'))
      const definition = summary.schema.types[type]
      if (!definition || state.stale) return []
      const fields = Object.keys(definition.fields).filter(
        (field) => !definition.fields[field]!.sampled,
      )
      const ask = async (query: RowsQuery) =>
        (await studio.client.call('query', {
          uri: summary.uri,
          version: summary.version,
          query,
        })) as RowsBlock[]
      const blocks = await ask({
        kind: 'rows',
        from: type,
        select: fields,
        ids: true,
        limit: 1,
        rows: { kind: 'ids', ids: [selection.id] },
      })
      const row = rowsOf(blocks, await referenceNames(blocks, ask))[0]
      if (!row) return []
      return fields.map((field) => {
        const value = row.values[field]
        const unit = definition.fields[field]!.unit
        const item = new Node(field)
        item.description = display(value) + (unit ? ' ' + unit : '')
        item.tooltip = new vscode.MarkdownString().appendText(
          `${type} · ${selection.id}\n${field}: ${display(value)}${unit ? ' [' + unit + ']' : ''}`,
        )
        item.command = {
          command: 'gridkitStudio.inspectField',
          title: 'Inspect field',
          arguments: [item],
        }
        item.target = {
          uri: summary.uri,
          version: summary.version,
          origin: 'inspector',
          type,
          field,
          element: { id: selection.id, field },
        }
        // The menus a row offers follow from what its field is.
        item.contextValue = Object.entries(menuContext(summary, item.target, state.bindings))
          .filter(([key, value]) => key.startsWith('gridkit') && value === true)
          .map(([key]) => key)
          .join(' ')
        item.id = [summary.uri, selection.id, field].join(':')
        return item
      })
    },
  }
  return [
    refresh,
    changed,
    vscode.window.createTreeView('gridkitStudio.inspector', {
      treeDataProvider: provider,
      showCollapseAll: false,
    }),
  ]
}
