import type { RowsBlock } from '@latkit/model'
import * as vscode from 'vscode'

import { rowsOf } from './cells.js'
import type { Sessions } from './sessions.js'
const descriptions: Record<string, string> = {
  inspect_case: 'Inspect the active GridKit case, schema, counts, units, and document revision.',
  query_rows: 'Read up to 100 rows from an open GridKit case.',
  read_diagnostics: 'Read current case diagnostics and stale-document status.',
  summarize_run: 'Summarize the current and previous local simulation runs.',
}
export function registerAI(studio: Sessions) {
  return Object.keys(descriptions).map((name) =>
    vscode.lm.registerTool('gridkit_' + name, {
      async invoke(
        options: vscode.LanguageModelToolInvocationOptions<{
          from?: string
          select?: string[]
          offset?: number
          limit?: number
        }>,
        token,
      ) {
        const session = studio.current()
        const state = studio.state(session.uri)
        if (!state.summary) throw new Error('No parsed case is open.')
        const controller = new AbortController()
        const subscription = token.onCancellationRequested(() => controller.abort())
        if (token.isCancellationRequested) controller.abort()
        try {
          let result: unknown
          if (name === 'inspect_case')
            result = {
              revision: state.summary.version,
              name: state.summary.name,
              counts: state.summary.counts,
              types: Object.fromEntries(
                Object.entries(state.summary.schema.types).filter(
                  ([type]) => state.summary!.counts[type],
                ),
              ),
              stale: state.stale,
            }
          else if (name === 'read_diagnostics')
            result = {
              revision: state.summary.version,
              stale: state.stale,
              diagnostics: studio.documents.diagnostics
                .get(vscode.Uri.parse(session.uri))
                ?.map((item) => ({
                  message: item.message,
                  severity: item.severity,
                  line: item.range.start.line + 1,
                })),
            }
          else if (name === 'summarize_run')
            result = { current: session.run, previous: session.previous }
          else {
            if (state.stale)
              throw new Error('Current document is invalid; the last projection is stale.')
            const input = options.input
            const from = input.from ?? 'Bus'
            const select =
              input.select ??
              Object.keys(state.summary.schema.types[from]?.fields ?? {}).filter(
                (field) => !state.summary!.schema.types[from]!.fields[field]!.sampled,
              )
            const blocks = (await studio.client.call(
              'query',
              {
                uri: session.uri,
                version: state.summary.version,
                query: {
                  kind: 'rows',
                  from,
                  select,
                  offset: Math.max(0, input.offset ?? 0),
                  limit: Math.min(100, Math.max(0, input.limit ?? 20)),
                  ids: true,
                  count: true,
                },
              },
              controller.signal,
            )) as RowsBlock[]
            result = {
              revision: state.summary.version,
              from,
              units: Object.fromEntries(
                select.map((field) => [
                  field,
                  state.summary!.schema.types[from]?.fields[field]?.unit,
                ]),
              ),
              rows: rowsOf(blocks),
            }
          }
          let text = JSON.stringify(result)
          if (Buffer.byteLength(text) > 32 << 10)
            text = JSON.stringify({
              revision: state.summary.version,
              truncated: true,
              message: 'Result exceeds 32 KiB. Request fewer rows or fields.',
            })
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
        } finally {
          subscription.dispose()
        }
      },
    }),
  )
}
export const toolContributions = descriptions
