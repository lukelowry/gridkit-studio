import * as vscode from 'vscode'

/** Keeps useful leading rows and continuation metadata within both host and byte budgets. */
export async function toolResult(
  result: Record<string, unknown>,
  token: vscode.CancellationToken,
  budget?: vscode.LanguageModelToolTokenizationOptions,
) {
  if (Array.isArray(result.rows)) result.returned = result.rows.length
  let text = JSON.stringify(result)
  const fits = async () =>
    Buffer.byteLength(text) <= 32 << 10 &&
    (!budget || (await budget.countTokens(text, token)) <= budget.tokenBudget)
  while (!(await fits())) {
    if (token.isCancellationRequested) throw new vscode.CancellationError()
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
  if (token.isCancellationRequested) throw new vscode.CancellationError()
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)])
}
