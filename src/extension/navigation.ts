/** A case's source as VS Code's editor reads it: completion, hover, go to definition, the outline,
 *  and the element under the cursor, selected in every view. */

import * as vscode from 'vscode'

import { CASE_FILE, CASE_GLOB } from '../shared/ids.js'
import { type CaseSymbol, revisionOf } from '../shared/messages.js'
import { withUnit } from '../shared/schema.js'
import { cancellable } from './client.js'
import { rangeOf } from './documents.js'
import type { Sessions } from './sessions.js'

const selector: vscode.DocumentSelector = { language: 'json', pattern: CASE_GLOB }
/** How many records the outline lists when VS Code's JSON features say nothing: their default. */
const OUTLINE_ITEMS = 5000

export function registerNavigation(studio: Sessions) {
  /** The case at `position`, with the summary it was read from. A case that does not parse answers
   *  nothing: its diagnostic already says why. */
  const inspect = async (
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
  ) => {
    const summary = await studio.documents.parsed(document)
    if (!summary) return undefined
    const context = await cancellable(token, (signal) =>
      studio.client.cases.call(
        'context',
        {
          ...revisionOf(summary),
          offset: document.offsetAt(position),
        },
        signal,
      ),
    )
    return { ...context, summary }
  }
  return [
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        async provideCompletionItems(document, position, token) {
          const completions = await cancellable(token, (signal) =>
            studio.documents.complete(document, document.offsetAt(position), signal),
          )
          return completions.map((field) => {
            const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field)
            item.detail = field.detail
            item.documentation = field.description
            return item
          })
        },
      },
      '"',
    ),
    vscode.languages.registerHoverProvider(selector, {
      async provideHover(document, position, token) {
        const context = await inspect(document, position, token)
        if (!context?.element?.field || !context.range) return
        const field = context.type
          ? context.summary.schema.types[context.type]?.fields[context.element.field]
          : undefined
        return new vscode.Hover(
          new vscode.MarkdownString().appendText(
            `${withUnit(context.element.field, field?.unit)}\n${field?.description ?? context.reference ?? context.element.id}`,
          ),
          rangeOf(document, context.range),
        )
      },
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(document, position, token) {
        const context = await inspect(document, position, token)
        const id = context?.reference
        if (!id) return
        const range = await cancellable(token, (signal) =>
          studio.client.cases.call(
            'locate',
            {
              ...revisionOf(context.summary),
              id,
            },
            signal,
          ),
        )
        return new vscode.Location(document.uri, rangeOf(document, range))
      },
    }),
    vscode.languages.registerDocumentSymbolProvider(selector, {
      async provideDocumentSymbols(document, token) {
        const summary = await studio.documents.parsed(document)
        if (!summary) return undefined
        // As many records as VS Code outlines of any JSON file, by its own setting.
        const limit =
          vscode.workspace.getConfiguration('json', document).get<number>('maxItemsComputed') ??
          OUTLINE_ITEMS
        const symbols = await cancellable(token, (signal) =>
          studio.client.cases.call(
            'symbols',
            {
              ...revisionOf(summary),
              limit,
            },
            signal,
          ),
        )
        // The file's arrays, each holding its records.
        const symbolOf = (symbol: CaseSymbol): vscode.DocumentSymbol => {
          const made = new vscode.DocumentSymbol(
            symbol.name,
            symbol.detail,
            symbol.children ? vscode.SymbolKind.Array : vscode.SymbolKind.Object,
            rangeOf(document, symbol),
            rangeOf(document, { offset: symbol.offset, length: 1 }),
          )
          made.children = symbol.children?.map(symbolOf) ?? []
          return made
        }
        return symbols.map(symbolOf)
      },
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const { document } = event.textEditor
      if (!CASE_FILE.test(document.fileName)) return
      const uri = document.uri.toString()
      // Typing moves the cursor: the case is read once the typing pauses, not at every key.
      if (studio.documents.get(uri)?.stale) return
      void inspect(document, event.selections[0]!.active)
        .then((context) => {
          if (context?.element) studio.get(uri)?.select(context.element)
        })
        // A revision a newer one replaced says nothing; anything else is said once, as any is.
        .catch((error) => studio.reporter.report(error))
    }),
  ]
}
