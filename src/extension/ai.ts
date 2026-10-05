import type { FieldSelection, RowsBlock, RowsQuery } from '@latkit/model'
import * as vscode from 'vscode'

import type { AnalysisOptions, RunTarget } from '../shared/analysis.js'
import { referenceNames, rowsOf } from '../shared/cells.js'
import type { Mutation, Revision, RunRequest } from '../shared/messages.js'
import { elementType } from '../shared/schema.js'
import { showPlot } from './actions.js'
import { toolResult } from './ai-output.js'
import { cancellable } from './client.js'
import { Proposals } from './proposals.js'
import type { Sessions } from './sessions.js'
import { cacheBytesOf, gridkitOf, type Tasks } from './tasks.js'

const page = (input: { offset?: number; limit?: number }) => {
  const offset = input.offset ?? 0
  const limit = input.limit ?? 20
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error('Use a nonnegative offset and a limit from 1 to 100.')
  return { offset, limit }
}
const revisionOf = (revision: Revision): Revision => ({
  uri: revision.uri,
  version: revision.version,
})
/** Model-facing values use stable references, never storage row numbers. */
function valuesOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(valuesOf)
  if (value && typeof value === 'object') {
    if ('index' in value && 'row' in value)
      return 'id' in value && value.id ? { id: value.id } : { unresolved: true }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, valuesOf(item)]))
  }
  return value
}

export function registerAI(studio: Sessions, tasks: Tasks) {
  const proposals = new Proposals(studio, tasks)
  const registrations: vscode.Disposable[] = [proposals]
  const sessionOf = (uri: string) => {
    const session = studio.all.get(uri)
    if (!session) throw new Error('The case is not open. Inspect open cases first.')
    return session
  }
  const register = <T>(
    name: string,
    description: string,
    run: (
      input: T,
      signal: AbortSignal,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ) => {
    registrations.push(
      vscode.lm.registerTool<T>('gridkit_' + name, {
        prepareInvocation: () => ({ invocationMessage: description }),
        async invoke(options, token) {
          const result = await cancellable(token, (signal) =>
            Promise.resolve(run(options.input, signal)),
          )
          return toolResult(result, token, options.tokenizationOptions)
        },
      }),
    )
  }
  register<{ uri?: string; from?: string; select?: string[]; offset?: number; limit?: number }>(
    'inspect_case',
    'Inspecting GridKit cases',
    async (input) => {
      const { offset, limit } = page(input)
      if (input.select && !input.from)
        throw new Error('Choose a type with from before selecting fields.')
      if (!input.uri) {
        const cases = [...studio.all.values()].map((session) => {
          const entry = studio.documents.entries.get(session.uri)
          return {
            uri: session.uri,
            version: entry?.document.version,
            parsedVersion: entry?.summary?.version,
            name: entry?.summary?.name,
            stale: entry?.stale ?? true,
          }
        })
        return {
          active: studio.active,
          cases: cases.slice(offset, offset + limit),
          offset,
          total: cases.length,
          nextOffset: offset + limit < cases.length ? offset + limit : null,
        }
      }
      const session = sessionOf(input.uri)
      const entry = studio.documents.entries.get(input.uri)
      if (!entry) throw new Error('The case document is closed.')
      await studio.documents.ensure(entry.document).catch(() => {})
      const summary = entry.summary
      const entries = Object.entries(summary?.schema.types ?? {}).filter(([type]) =>
        input.from ? type === input.from : !!summary?.counts[type],
      )
      if (input.from && !entries.length) throw new Error('Unknown case type.')
      const types = entries.slice(offset, offset + limit).map(([type, definition]) => ({
        type,
        label: definition.label,
        count: summary?.counts[type] ?? 0,
        identity: summary?.identities[type],
        ...(input.from
          ? {
              fields: input.select
                ? Object.fromEntries(
                    input.select.map((field) => {
                      if (!definition.fields[field]) throw new Error('Unknown field: ' + field)
                      return [field, definition.fields[field]]
                    }),
                  )
                : definition.fields,
              editable: summary?.editable[type] ?? [],
            }
          : {}),
      }))
      return {
        revision: { uri: input.uri, version: entry.document.version },
        parsedVersion: summary?.version,
        fingerprint: summary?.fingerprint,
        name: summary?.name,
        stale: entry.stale,
        error: entry.error,
        selection: session.selection,
        types,
        offset,
        total: entries.length,
        nextOffset: offset + limit < entries.length ? offset + limit : null,
        ...(input.from ? {} : { parameters: summary?.parameters }),
      }
    },
  )
  register<
    Revision & {
      from: string
      select: string[]
      ids?: string[]
      where?: RowsQuery['where']
      orderBy?: RowsQuery['orderBy']
      offset?: number
      limit?: number
    }
  >('query_rows', 'Reading GridKit rows', async (input, signal) => {
    const summary = studio.documents.require(input)
    const { offset, limit } = page(input)
    const fields = summary.schema.types[input.from]?.fields
    if (
      !fields ||
      !input.select.length ||
      input.select.length > 40 ||
      input.select.some((field) => !fields[field] || fields[field]!.sampled)
    )
      throw new Error(
        'Choose 1 to 40 static fields from inspect_case. Use analyze_run for recorded signals.',
      )
    const query = async (query: RowsQuery) =>
      (await studio.client.call(
        'query',
        { ...revisionOf(input), query, maxBytes: 512 << 10 },
        signal,
      )) as RowsBlock[]
    const blocks = await query({
      kind: 'rows',
      from: input.from,
      select: input.select,
      ...(input.ids ? { rows: { kind: 'ids' as const, ids: input.ids } } : {}),
      ...(input.where ? { where: input.where } : {}),
      ...(input.orderBy ? { orderBy: input.orderBy } : {}),
      offset,
      limit,
      ids: true,
      count: true,
    })
    const references = await referenceNames(blocks, query)
    studio.documents.require(input)
    const rows = rowsOf(blocks, references).map(({ id, values }) => ({
      id,
      values: valuesOf(values),
    }))
    const total = blocks[0]?.total ?? 0
    return {
      revision: revisionOf(input),
      fingerprint: summary.fingerprint,
      from: input.from,
      units: Object.fromEntries(input.select.map((field) => [field, fields[field]!.unit ?? null])),
      rows,
      offset,
      total,
      returned: rows.length,
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
    }
  })
  register<{ uri: string; offset?: number; limit?: number }>(
    'read_diagnostics',
    'Reading GridKit diagnostics',
    async (input) => {
      const entry = studio.documents.entries.get(input.uri)
      if (!entry) throw new Error('The case document is closed.')
      await studio.documents.ensure(entry.document).catch(() => {})
      const { offset, limit } = page(input)
      const diagnostics = studio.documents.diagnostics.get(entry.document.uri) ?? []
      return {
        revision: { uri: input.uri, version: entry.document.version },
        diagnosticsVersion: entry.diagnosticsVersion,
        parsedVersion: entry.summary?.version,
        stale: entry.stale,
        diagnostics: diagnostics.slice(offset, offset + limit).map((item, n) => ({
          message: item.message,
          severity: vscode.DiagnosticSeverity[item.severity].toLowerCase(),
          line: item.range.start.line + 1,
          column: item.range.start.character + 1,
          ...(entry.summary?.version === entry.diagnosticsVersion
            ? {
                id: entry.summary?.issues[offset + n]?.id,
                field: entry.summary?.issues[offset + n]?.field,
              }
            : {}),
        })),
        offset,
        total: diagnostics.length,
        nextOffset: offset + limit < diagnostics.length ? offset + limit : null,
      }
    },
  )
  register<{ uri: string }>(
    'summarize_run',
    'Reading GridKit run evidence',
    async (input, signal) => {
      const session = sessionOf(input.uri)
      const retained = await studio.client.call('runs', { uri: input.uri }, signal)
      const version = studio.documents.entries.get(input.uri)?.document.version
      const describe = (run: typeof session.run) =>
        run
          ? {
              ...run,
              matchesDocument: version === run.revision.version,
              retained: retained.some((item) => item.id === run.id),
              scope: run.contingency
                ? 'displayed contingency; use study id and index to inspect siblings'
                : 'single run',
            }
          : null
      return {
        uri: input.uri,
        documentVersion: version,
        current: describe(session.run),
        previous: describe(session.previous),
        retained: retained.map((run) => ({
          id: run.id,
          study: run.contingency?.study,
          revision: run.revision,
        })),
        recording: session.outputs,
      }
    },
  )
  register<RunTarget & AnalysisOptions>(
    'analyze_run',
    'Analyzing recorded GridKit signals',
    async (input, signal) => ({ ...(await studio.client.call('analyze', input, signal)) }),
  )
  register<{ before: RunTarget; after: RunTarget } & AnalysisOptions>(
    'compare_runs',
    'Comparing recorded GridKit extrema',
    async (input, signal) => ({ ...(await studio.client.call('compare', input, signal)) }),
  )
  register<RunTarget & AnalysisOptions & { contingencies?: number[] }>(
    'rank_contingencies',
    'Ranking GridKit contingencies',
    async (input, signal) => ({ ...(await studio.client.call('rank', input, signal)) }),
  )
  register<Revision & { action: 'reveal' | 'plot'; id: string; field?: string; run?: string }>(
    'show_element',
    'Showing a GridKit element',
    async (input, signal) => {
      const summary = studio.documents.require(input)
      const session = sessionOf(input.uri)
      const element = { id: input.id, field: input.field }
      const from = elementType(input.id)
      await studio.client.call('locate', { ...revisionOf(input), ...element }, signal)
      studio.documents.require(input)
      signal.throwIfAborted()
      if (input.action === 'reveal') await studio.documents.reveal(input.uri, element)
      else {
        if (!input.field || !summary.schema.types[from]?.fields[input.field]?.sampled)
          throw new Error('Choose a sampled field to plot.')
        if (!session.run || input.run !== session.run.id)
          throw new Error('Name the currently displayed run. Summarize the case runs first.')
        if (session.run.fingerprint !== summary.fingerprint)
          throw new Error(
            'The displayed run belongs to different case content. Analyze its captured data instead.',
          )
        await studio.client.call(
          'analyze',
          {
            uri: input.uri,
            run: input.run,
            from,
            field: input.field,
            ids: [input.id],
            window: [session.run.domain[1], session.run.domain[1]],
            limit: 1,
          },
          signal,
        )
        studio.documents.require(input)
        signal.throwIfAborted()
        if (session.run?.id !== input.run)
          throw new Error('The displayed run changed. Summarize the runs again.')
        await showPlot(studio, session, { from, field: input.field, id: input.id }, element)
      }
      return { revision: revisionOf(input), action: input.action, element }
    },
  )
  register<Revision & { changes: Extract<Mutation, { kind: 'set' }>[] }>(
    'propose_edits',
    'Preparing a GridKit edit review',
    async (input, signal) => {
      studio.documents.require(input)
      if (Buffer.byteLength(JSON.stringify(input.changes)) > 256 << 10)
        throw new Error(
          'Proposed field values exceed 256 KiB. Split the edit into smaller proposals.',
        )
      if (
        !input.changes.length ||
        input.changes.length > 100 ||
        input.changes.some((change) => change.kind !== 'set')
      )
        throw new Error('Propose 1 to 100 field edits.')
      const edits = await studio.client.call(
        'transact',
        { ...revisionOf(input), mutations: input.changes },
        signal,
      )
      signal.throwIfAborted()
      return proposals.edit(revisionOf(input), input.changes, edits)
    },
  )
  register<Revision & { values?: Record<string, unknown>; outputs?: FieldSelection[] }>(
    'propose_run',
    'Checking a GridKit simulation proposal',
    async (input, signal) => {
      if (!vscode.workspace.isTrusted)
        throw new Error('Trust this workspace to check and execute GridKit.')
      studio.documents.require(input)
      const session = sessionOf(input.uri)
      const uri = vscode.Uri.parse(input.uri)
      const request: RunRequest = {
        ...revisionOf(input),
        values: structuredClone({ ...session.values, ...input.values }),
        outputs: structuredClone(input.outputs ?? session.outputs ?? []),
        gridkit: gridkitOf(uri),
        cacheBytes: cacheBytesOf(uri),
      }
      const preview = await studio.client.call('preflight', request, signal)
      request.values = preview.values
      signal.throwIfAborted()
      return { ...proposals.run(request, preview), preview, outputs: request.outputs }
    },
  )
  return registrations
}
