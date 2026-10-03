import * as vscode from 'vscode'

import type { Sessions } from './sessions.js'
const selector: vscode.DocumentSelector = { language: 'json', pattern: '**/*.case.json' }
export function registerNavigation(studio: Sessions) {
  const inspect = async (
    document: vscode.TextDocument,
    position: vscode.Position,
    token?: vscode.CancellationToken,
  ) => {
    const summary = await studio.documents.ensure(document)
    const controller = new AbortController()
    const cancellation = token?.onCancellationRequested(() => controller.abort())
    if (token?.isCancellationRequested) controller.abort()
    try {
      return await studio.client.call(
        'context',
        {
          uri: document.uri.toString(),
          version: summary.version,
          offset: document.offsetAt(position),
        },
        controller.signal,
      )
    } finally {
      cancellation?.dispose()
    }
  }
  return [
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        async provideCompletionItems(document, position, token) {
          const controller = new AbortController()
          const subscription = token.onCancellationRequested(() => controller.abort())
          if (token.isCancellationRequested) controller.abort()
          const completions = await studio.client
            .call(
              'complete',
              { text: document.getText(), offset: document.offsetAt(position) },
              controller.signal,
            )
            .finally(() => subscription.dispose())
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
        if (!context.element?.field || !context.range) return
        const summary = studio.state(document.uri.toString()).summary!
        const field = summary.schema.types[context.type!]!.fields[context.element.field]!
        return new vscode.Hover(
          new vscode.MarkdownString().appendText(
            `${context.element.field}${field.unit ? ' [' + field.unit + ']' : ''}\n${field.description ?? context.reference ?? context.element.id}`,
          ),
          new vscode.Range(
            document.positionAt(context.range.offset),
            document.positionAt(context.range.offset + context.range.length),
          ),
        )
      },
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(document, position, token) {
        const context = await inspect(document, position, token)
        if (!context.reference) return
        const range = await studio.client.call('locate', {
          uri: document.uri.toString(),
          version: document.version,
          id: context.reference,
        })
        return new vscode.Location(
          document.uri,
          new vscode.Range(
            document.positionAt(range.offset),
            document.positionAt(range.offset + range.length),
          ),
        )
      },
    }),
    vscode.languages.registerDocumentSymbolProvider(selector, {
      async provideDocumentSymbols(document, token) {
        await studio.documents.ensure(document)
        const controller = new AbortController()
        const subscription = token.onCancellationRequested(() => controller.abort())
        try {
          const symbols = await studio.client.call(
            'symbols',
            { uri: document.uri.toString(), version: document.version },
            controller.signal,
          )
          return symbols.map(
            (symbol) =>
              new vscode.DocumentSymbol(
                symbol.name,
                symbol.detail,
                vscode.SymbolKind.Object,
                new vscode.Range(
                  document.positionAt(symbol.offset),
                  document.positionAt(symbol.offset + symbol.length),
                ),
                new vscode.Range(
                  document.positionAt(symbol.offset),
                  document.positionAt(symbol.offset + 1),
                ),
              ),
          )
        } finally {
          subscription.dispose()
        }
      },
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!/\.case\.json$/i.test(event.textEditor.document.fileName)) return
      void inspect(event.textEditor.document, event.selections[0]!.active)
        .then((context) => {
          if (context.element)
            studio.select(event.textEditor.document.uri.toString(), context.element)
        })
        .catch(() => {})
    }),
  ]
}
