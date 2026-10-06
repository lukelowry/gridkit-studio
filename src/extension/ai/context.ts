import { AsyncLocalStorage } from 'node:async_hooks'

import type { RowsQuery } from '@latkit/model'
import * as vscode from 'vscode'

import { problem } from '../../shared/ai.js'
import { pageOf } from '../../shared/inspection.js'
import type { Summary } from '../../shared/messages.js'
import type { ToolCapability } from '../../shared/tools.js'
import type { Sessions } from '../sessions.js'

export interface ToolHandler {
  name: string
  message: string
  readOnly: boolean
  capability: ToolCapability
  run(input: unknown, signal: AbortSignal): Promise<Record<string, unknown>>
}
export type Register = <T>(
  name: string,
  execute: (input: T, signal: AbortSignal) => Promise<Record<string, unknown>>,
) => void
export interface CaseInput {
  caseUri: string
  caseRevision?: string
}
export interface ComponentQuery extends CaseInput {
  componentType: string
  fields: string[]
  componentIds?: string[]
  where?: RowsQuery['where']
  orderBy?: RowsQuery['orderBy']
  offset?: number
  limit?: number
}
const caseLeases = new AsyncLocalStorage<string[]>()
export async function withCaseLeases<T>(studio: Sessions, execute: () => Promise<T>) {
  const leases: string[] = []
  try {
    return await caseLeases.run(leases, execute)
  } finally {
    await Promise.all(
      leases.map((snapshotId) =>
        studio.client.call('releaseSnapshot', { snapshotId }).catch(() => {}),
      ),
    )
  }
}

export async function resolveCase(studio: Sessions, input: CaseInput, signal: AbortSignal) {
  const uri = vscode.Uri.parse(input.caseUri)
  if (!vscode.workspace.getWorkspaceFolder(uri) || !uri.path.endsWith('.case.json'))
    throw problem('invalid-case', 'Choose a workspace .case.json URI from list_cases.')
  const document = await vscode.workspace.openTextDocument(uri)
  signal.throwIfAborted()
  const summary = await studio.documents.ensure(document)
  signal.throwIfAborted()
  if (input.caseRevision && input.caseRevision !== summary.fingerprint)
    throw problem(
      'revision-conflict',
      'Case content changed. Inspect the current case before editing or resubmitting.',
      {
        expectedRevision: input.caseRevision,
        actualRevision: summary.fingerprint,
      },
    )
  const leases = caseLeases.getStore()
  if (!leases) return { document, summary }
  const captured = await studio.client.call('captureCase', revision(summary), signal)
  leases.push(captured.snapshotId)
  return { document, summary: { ...summary, snapshotId: captured.snapshotId } }
}
export const reference = (summary: Summary) => ({
  caseUri: summary.uri,
  caseRevision: summary.fingerprint,
})
export const revision = (summary: Summary) => ({
  uri: summary.uri,
  version: summary.version,
  attachmentId: summary.attachmentId,
  snapshotId: summary.snapshotId,
})
export function paged<T>(items: readonly T[], input: { offset?: number; limit?: number }) {
  const { offset, limit } = pageOf(input)
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    nextOffset: offset + limit < items.length ? offset + limit : null,
  }
}

/** Adapt domain calculation results once; transport adapters never rename fields independently. */
export function publicResult(source: Record<string, unknown>): Record<string, unknown> {
  const {
    run,
    study,
    contingency,
    revision: captured,
    fingerprint,
    from,
    window,
    evidence,
    rows,
    before,
    after,
    ...rest
  } = source
  return {
    ...rest,
    ...(run || study ? { simulationId: study ?? run } : {}),
    ...(contingency !== undefined ? { contingencyIndex: contingency } : {}),
    ...(captured && typeof captured === 'object' && 'uri' in captured
      ? { caseUri: captured.uri }
      : {}),
    ...(fingerprint ? { caseRevision: fingerprint } : {}),
    ...(from ? { componentType: from } : {}),
    ...(window ? { timeRange: window } : {}),
    ...(evidence ? { analysisId: evidence } : {}),
    ...(Array.isArray(rows)
      ? {
          items: rows.map(publicFinding),
        }
      : {}),
    ...(before ? { before: publicResult(before as Record<string, unknown>) } : {}),
    ...(after ? { after: publicResult(after as Record<string, unknown>) } : {}),
  }
}

/** Findings can contain component extrema nested under comparisons and ranked contingencies. */
function publicFinding(item: unknown): unknown {
  if (!item || typeof item !== 'object') return item
  const { id, contingency, before, after, worst, ...fields } = item as Record<string, unknown>
  return {
    ...fields,
    ...(id !== undefined ? { componentId: id } : {}),
    ...(contingency !== undefined ? { contingencyIndex: contingency } : {}),
    ...(before !== undefined ? { before: publicFinding(before) } : {}),
    ...(after !== undefined ? { after: publicFinding(after) } : {}),
    ...(worst !== undefined ? { worst: publicFinding(worst) } : {}),
  }
}
