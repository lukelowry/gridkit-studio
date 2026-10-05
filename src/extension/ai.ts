import type { RowsBlock } from '@latkit/model'
import * as vscode from 'vscode'

import { rowsOf } from '../shared/cells.js'
import { cancellable } from './client.js'
import type { Sessions } from './sessions.js'

/** Language model tools, registered as `gridkit_<name>` and described in package.json. */
const TOOLS = ['inspect_case', 'query_rows', 'read_diagnostics', 'summarize_run'] as const

export function registerAI(studio: Sessions) {
  return TOOLS.map((name) =>
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
        const { summary } = state
        if (!summary) throw new Error('No parsed case is open.')
        let result: unknown
        if (name === 'inspect_case')
          result = {
            revision: summary.version,
            name: summary.name,
            counts: summary.counts,
            types: Object.fromEntries(
              Object.entries(summary.schema.types).filter(([type]) => summary.counts[type]),
            ),
            stale: state.stale,
          }
        else if (name === 'read_diagnostics')
          result = {
            revision: summary.version,
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
          const fields = summary.schema.types[from]?.fields ?? {}
          const select =
            input.select ?? Object.keys(fields).filter((field) => !fields[field]!.sampled)
          const blocks = (await cancellable(token, (signal) =>
            studio.client.call(
              'query',
              {
                uri: session.uri,
                version: summary.version,
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
              signal,
            ),
          )) as RowsBlock[]
          result = {
            revision: summary.version,
            from,
            units: Object.fromEntries(select.map((field) => [field, fields[field]?.unit])),
            rows: rowsOf(blocks),
          }
        }
        let text = JSON.stringify(result)
        if (Buffer.byteLength(text) > 32 << 10)
          text = JSON.stringify({
            revision: summary.version,
            truncated: true,
            message: 'Result exceeds 32 KiB. Request fewer rows or fields.',
          })
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
      },
    }),
  )
}
