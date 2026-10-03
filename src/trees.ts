import type { RowsBlock } from '@latkit/model'
import * as vscode from 'vscode'

import { display, referenceNames, rowsOf } from './cells.js'
import type { Element } from './messages.js'
import type { Sessions } from './sessions.js'
export class Node extends vscode.TreeItem {
  constructor(
    label: string,
    readonly data: {
      type?: string
      field?: string
      id?: string
      value?: unknown
      offset?: number
      kind: 'type' | 'field' | 'element' | 'value' | 'more'
    },
    collapsibleState = vscode.TreeItemCollapsibleState.None,
  ) {
    super(label, collapsibleState)
  }
}
export function registerTrees(studio: Sessions) {
  const changed = new vscode.EventEmitter<Node | undefined>()
  let revision = ''
  const refresh = studio.changed.event(() => {
    const state = studio.active ? studio.state(studio.active) : undefined
    const next = [studio.active, state?.summary?.version, state?.stale, state?.selection?.id].join(
      ':',
    )
    if (next !== revision) {
      revision = next
      changed.fire(undefined)
    }
  })
  const query = async (type: string, select: string[], offset = 0, id?: string) => {
    const state = studio.state(studio.current().uri)
    if (!state.summary || state.stale) return []
    const blocks = (await studio.client.call('query', {
      uri: state.summary.uri,
      version: state.summary.version,
      query: {
        kind: 'rows',
        from: type,
        select,
        ids: true,
        limit: 100,
        offset,
        ...(id ? { rows: { kind: 'ids', ids: [id] } } : {}),
      },
    })) as RowsBlock[]
    const references = await referenceNames(
      blocks,
      async (query) =>
        (await studio.client.call('query', {
          uri: state.summary!.uri,
          version: state.summary!.version,
          query,
        })) as RowsBlock[],
    )
    return rowsOf(blocks, references)
  }
  const provider = (signals: boolean): vscode.TreeDataProvider<Node> => ({
    onDidChangeTreeData: changed.event,
    getTreeItem: (node) => node,
    async getChildren(node) {
      if (!studio.active) return []
      const state = studio.state(studio.active)
      const summary = state.summary
      if (!summary) return []
      if (!signals && !node) {
        const selected = state.selection
        if (!selected)
          return [
            new Node('Select an element in Network, Diagram, Table, or JSON.', { kind: 'value' }),
          ]
        const type = selected.id.slice(0, selected.id.indexOf('/'))
        const definition = summary.schema.types[type]
        if (!definition) return []
        const fields = Object.keys(definition.fields).filter(
          (field) => !definition.fields[field]!.sampled,
        )
        const rows = await query(type, fields, 0, selected.id)
        if (!rows[0]) return []
        return fields.map((field) => {
          const value = rows[0]!.values[field]
          const definition = summary.schema.types[type]!.fields[field]!
          const item = new Node(field, { kind: 'value', type, field, id: selected.id, value })
          item.description = display(value) + (definition.unit ? ' ' + definition.unit : '')
          item.tooltip = new vscode.MarkdownString().appendText(
            `${type} · ${selected.id}\n${field}: ${display(value)}${definition.unit ? ' [' + definition.unit + ']' : ''}`,
          )
          item.contextValue = summary.editable[type]?.includes(field) ? 'editable' : 'identity'
          item.command = {
            command: 'gridkitStudio.inspectField',
            title: 'Inspect field',
            arguments: [item],
          }
          return item
        })
      }
      if (!node)
        return Object.entries(summary.counts)
          .filter(
            ([type, count]) =>
              count > 0 &&
              Object.values(summary.schema.types[type]!.fields).some((field) => field.sampled),
          )
          .map(([type, count]) => {
            const item = new Node(
              summary.schema.types[type]!.label ?? type,
              { kind: 'type', type },
              vscode.TreeItemCollapsibleState.Collapsed,
            )
            item.description = String(count)
            return item
          })
      const type = node.data.type!
      if (node.data.kind === 'type')
        return Object.entries(summary.schema.types[type]!.fields)
          .filter(([, definition]) => definition.sampled)
          .map(([field, definition]) => {
            const item = new Node(
              definition.label ?? field,
              { kind: 'field', type, field },
              vscode.TreeItemCollapsibleState.Collapsed,
            )
            item.description = definition.unit
            item.contextValue = 'signal'
            return item
          })
      if (node.data.kind === 'field' || node.data.kind === 'more') {
        const name = summary.schema.types[type]!.fields.name
          ? 'name'
          : summary.schema.types[type]!.fields.number
            ? 'number'
            : 'signal_id'
        const offset = node.data.offset ?? 0
        const rows = await query(type, [name], offset)
        const nodes = rows.map((row) => {
          const item = new Node(display(row.values[name]), {
            kind: 'element',
            type,
            field: node.data.field,
            id: row.id ?? undefined,
          })
          item.description = row.id ?? ''
          item.contextValue = 'signal'
          item.command = { command: 'gridkitStudio.plot', title: 'Plot signal', arguments: [item] }
          return item
        })
        if (offset + rows.length < summary.counts[type]!)
          nodes.push(
            new Node(
              'Next 100…',
              { ...node.data, kind: 'more', offset: offset + 100 },
              vscode.TreeItemCollapsibleState.Collapsed,
            ),
          )
        return nodes
      }
      return []
    },
  })
  return [
    refresh,
    changed,
    vscode.window.createTreeView('gridkitStudio.inspector', {
      treeDataProvider: provider(false),
      showCollapseAll: true,
    }),
    vscode.window.createTreeView('gridkitStudio.signals', {
      treeDataProvider: provider(true),
      showCollapseAll: true,
    }),
  ]
}
export function elementOf(value: unknown): Element | undefined {
  if (value instanceof Node && value.data.id)
    return { id: value.data.id, ...(value.data.field ? { field: value.data.field } : {}) }
  if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string')
    return value as Element
}
