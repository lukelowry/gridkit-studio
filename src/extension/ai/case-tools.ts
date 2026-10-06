import type { RowsBlock, RowsQuery } from '@latkit/model'
import * as vscode from 'vscode'

import { type EditCaseInput, problem } from '../../shared/ai.js'
import { referenceNames, rowsOf } from '../../shared/cells.js'
import { pageOf } from '../../shared/inspection.js'
import type { Mutation } from '../../shared/messages.js'
import type { Requests } from '../requests.js'
import { defaultOutputs, type Sessions } from '../sessions.js'
import {
  type CaseInput,
  type ComponentQuery,
  paged,
  publicResult,
  reference,
  type Register,
  resolveCase,
  revision,
} from './context.js'

/** References leave the worker as stable native identities, never storage row numbers. */
function valuesOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(valuesOf)
  if (value && typeof value === 'object') {
    if ('index' in value && 'row' in value)
      return 'id' in value && value.id ? { componentId: value.id } : { unresolved: true }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, valuesOf(item)]))
  }
  return value
}
function mutationsOf(input: EditCaseInput): Mutation[] {
  return input.changes.map((change) => {
    switch (change.kind) {
      case 'add':
        return { kind: 'add', type: change.componentType, key: change.key, fields: change.fields }
      case 'set':
        return { kind: 'set', id: change.componentId, field: change.field, value: change.value }
      case 'remove':
        return { kind: 'remove', ids: change.componentIds }
      case 'move':
        return { kind: 'move', id: change.componentId, position: change.position }
      case 'connect':
        return {
          kind: 'connect',
          from: { id: change.from.componentId, field: change.from.field },
          to: change.to && { id: change.to.componentId, field: change.to.field },
        }
    }
  })
}
export function caseTools(studio: Sessions, requests: Requests, register: Register) {
  register<{ offset?: number; limit?: number }>('list_cases', async (input, signal) => {
    const source = new vscode.CancellationTokenSource()
    const abort = () => source.cancel()
    signal.addEventListener('abort', abort, { once: true })
    try {
      const files = await vscode.workspace.findFiles(
        '**/*.case.json',
        '**/{node_modules,.git,.vscode-test,output}/**',
        undefined,
        source.token,
      )
      signal.throwIfAborted()
      files.sort((a, b) => a.toString().localeCompare(b.toString()))
      return paged(
        files.map((uri) => ({
          caseUri: uri.toString(),
          path: vscode.workspace.asRelativePath(uri),
          open: studio.documents.entries.has(uri.toString()),
        })),
        input,
      )
    } finally {
      signal.removeEventListener('abort', abort)
      source.dispose()
    }
  })
  register<CaseInput & { offset?: number; limit?: number; includeEmpty?: boolean }>(
    'describe_case',
    async (input, signal) => {
      const { summary } = await resolveCase(studio, input, signal)
      const session = studio.all.get(input.caseUri)
      return {
        ...reference(summary),
        name: summary.name,
        ...paged(
          Object.entries(summary.schema.types)
            .filter(([type]) => input.includeEmpty || summary.counts[type])
            .map(([componentType, type]) => ({
              componentType,
              label: type.label,
              count: summary.counts[componentType] ?? 0,
              identity: summary.identities[componentType],
            })),
          input,
        ),
        parameters: summary.parameters,
        parametersOverride: session?.values ?? {},
        recording: (session?.outputs ?? defaultOutputs(summary)).map((item) => ({
          componentType: item.from,
          fields: item.select,
          ...('rows' in item && item.rows?.kind === 'ids' ? { componentIds: item.rows.ids } : {}),
        })),
        diagnostics: {
          errors: summary.issues.filter((issue) => issue.severity === 'error').length,
          warnings: summary.issues.filter((issue) => issue.severity === 'warning').length,
        },
      }
    },
  )
  register<CaseInput & { componentType: string; fields?: string[] }>(
    'describe_component_type',
    async (input, signal) => {
      const { summary } = await resolveCase(studio, input, signal)
      const definition = summary.schema.types[input.componentType]
      if (!definition) throw problem('component-type-not-found', 'Unknown GridKit component type.')
      const fields = input.fields ?? Object.keys(definition.fields)
      for (const field of fields)
        if (!definition.fields[field])
          throw problem('field-not-found', 'Unknown field: ' + field, { field })
      return {
        ...reference(summary),
        componentType: input.componentType,
        label: definition.label,
        identity: summary.identities[input.componentType],
        count: summary.counts[input.componentType] ?? 0,
        fields: Object.fromEntries(fields.map((field) => [field, definition.fields[field]])),
        editable: summary.editable[input.componentType] ?? [],
        creation: summary.creation?.[input.componentType],
      }
    },
  )
  register<ComponentQuery & { saveSelection?: boolean }>(
    'find_components',
    async (input, signal) => {
      const { summary } = await resolveCase(studio, input, signal)
      const fields = summary.schema.types[input.componentType]?.fields
      if (!fields || input.fields.some((field) => !fields[field] || fields[field]!.sampled))
        throw problem(
          'invalid-field',
          'Choose static fields from describe_component_type; analyze_results reads recorded signals.',
        )
      const { offset, limit } = pageOf(input)
      const base = revision(summary)
      const query = async (query: RowsQuery) =>
        (await studio.client.call('query', { ...base, query }, signal)) as RowsBlock[]
      const blocks = await query({
        kind: 'rows',
        from: input.componentType,
        select: input.fields,
        ...(input.componentIds ? { rows: { kind: 'ids', ids: input.componentIds } } : {}),
        ...(input.where ? { where: input.where } : {}),
        ...(input.orderBy ? { orderBy: input.orderBy } : {}),
        offset,
        limit,
        ids: true,
        count: true,
      })
      const names = await referenceNames(blocks, query)
      const items = rowsOf(blocks, names).map(({ id, values }) => ({
        componentId: id,
        values: valuesOf(values),
      }))
      const selection = input.saveSelection
        ? await studio.client.call(
            'selection',
            { ...base, from: input.componentType, ids: input.componentIds, where: input.where },
            signal,
          )
        : undefined
      const total = blocks[0]?.total ?? 0
      return {
        ...reference(summary),
        componentType: input.componentType,
        items,
        total,
        offset,
        nextOffset: offset + items.length < total ? offset + items.length : null,
        units: Object.fromEntries(
          input.fields.map((field) => [field, fields[field]!.unit ?? null]),
        ),
        ...(selection ? { selectionId: selection.selection, selectionCount: selection.count } : {}),
      }
    },
  )
  register<ComponentQuery & { groupBy?: string }>('summarize_components', async (input, signal) => {
    const { summary } = await resolveCase(studio, input, signal)
    return publicResult(
      await studio.client.call(
        'aggregate',
        {
          ...revision(summary),
          from: input.componentType,
          fields: input.fields,
          ids: input.componentIds,
          where: input.where,
          groupBy: input.groupBy,
          offset: input.offset,
          limit: input.limit,
        },
        signal,
      ),
    )
  })
  register<CaseInput & { offset?: number; limit?: number }>('check_case', async (input, signal) => {
    let parseError: unknown
    try {
      await resolveCase(studio, input, signal)
    } catch (error) {
      parseError = error
    }
    signal.throwIfAborted()
    const entry = studio.documents.entries.get(input.caseUri)
    if (!entry) throw parseError
    const diagnostics = studio.documents.diagnostics.get(entry.document.uri) ?? []
    return {
      caseUri: input.caseUri,
      caseRevision: entry.stale ? undefined : entry.summary?.fingerprint,
      valid:
        !entry.stale &&
        !diagnostics.some((item) => item.severity === vscode.DiagnosticSeverity.Error),
      ...paged(
        diagnostics.map((item, index) => ({
          message: item.message,
          severity: vscode.DiagnosticSeverity[item.severity].toLowerCase(),
          line: item.range.start.line + 1,
          column: item.range.start.character + 1,
          componentId: entry.stale ? undefined : entry.summary?.issues[index]?.id,
          field: entry.stale ? undefined : entry.summary?.issues[index]?.field,
        })),
        input,
      ),
    }
  })
  register<
    CaseInput & {
      componentId: string
      network: 'electrical' | 'control'
      hops: number
      offset?: number
      limit?: number
    }
  >('trace_connections', async (input, signal) => {
    const { summary } = await resolveCase(studio, input, signal)
    return publicResult(
      await studio.client.call(
        'neighborhood',
        {
          ...revision(summary),
          id: input.componentId,
          network: input.network,
          hops: input.hops,
          offset: input.offset,
          limit: input.limit,
        },
        signal,
      ),
    )
  })
  register<EditCaseInput>('edit_case', (input, signal) =>
    requests.perform('case-edit', input, async (receipt, save) => {
      const { summary } = await resolveCase(studio, input, signal)
      const mutations = mutationsOf(input)
      // Complete validation before reserving the uncertain side-effect boundary.
      const edits = await studio.client.call(
        'transact',
        { ...revision(summary), mutations },
        signal,
      )
      signal.throwIfAborted()
      receipt.beforeRevision = summary.fingerprint
      receipt.state = 'prepared'
      await save()
      const document = await studio.documents.transactContent(
        summary.uri,
        summary.fingerprint,
        mutations,
        edits,
      )
      const after = await studio.documents.ensure(document)
      receipt.afterRevision = after.fingerprint
      return {
        requestId: input.requestId,
        changeId: receipt.resourceId,
        caseUri: input.caseUri,
        status: 'applied',
        beforeRevision: summary.fingerprint,
        afterRevision: after.fingerprint,
        changes: mutations.length,
        unsaved: document.isDirty,
      }
    }),
  )
}
