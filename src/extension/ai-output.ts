import * as vscode from 'vscode'

/** The result whole, or, where the chat host gives the tool a token budget, its leading rows and
 *  where to continue. */
export async function toolResult(
  result: Record<string, unknown>,
  token: vscode.CancellationToken,
  budget?: vscode.LanguageModelToolTokenizationOptions,
) {
  const { text } = await boundedResult(
    result,
    () => {
      if (token.isCancellationRequested) throw new vscode.CancellationError()
    },
    budget && (async (text) => (await budget.countTokens(text, token)) <= budget.tokenBudget),
  )
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
}

/** Fit a response to the host's budget, if it has one, without changing the source object or its
 *  arrays. */
export async function boundedResult(
  source: Record<string, unknown>,
  check: () => void,
  accepts?: (text: string) => Promise<boolean>,
) {
  check()
  const result = { ...source }
  if (Array.isArray(result.rows)) result.returned = result.rows.length
  let text = JSON.stringify(result)
  while (accepts && !(await accepts(text))) {
    check()
    const lists = Object.entries(result).filter(
      (entry): entry is [string, unknown[]] =>
        ['rows', 'diagnostics', 'types', 'cases'].includes(entry[0]) &&
        Array.isArray(entry[1]) &&
        entry[1].length > 0,
    )
    const largest = lists.sort(
      (a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length,
    )[0]
    if (!largest)
      throw new Error(
        'The requested metadata exceeds the response budget. Select a type, fewer fields, or a larger token budget.',
      )
    const [key, values] = largest
    const retained = values.slice(0, Math.floor(values.length / 2))
    result[key] = retained
    result.truncated = true
    if (key === 'rows' || key === 'diagnostics' || key === 'types' || key === 'cases') {
      result.returned = retained.length
      if (typeof result.offset === 'number') result.nextOffset = result.offset + retained.length
    }
    if (!retained.length && values.length === 1) {
      result.message =
        'One item exceeds the response budget. Request fewer fields or a larger token budget.'
      delete result.nextOffset
    }
    text = JSON.stringify(result)
  }
  check()
  return { result, text }
}
