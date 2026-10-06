import * as vscode from 'vscode'

import { toolProblem } from '../../shared/ai.js'
import { cancellable } from '../client.js'
import type { ToolHandler } from './context.js'
import { toolResult } from './output.js'

/** VS Code owns approval and its remembered scope; preparation never creates side effects. */
export function registerNative(tools: readonly ToolHandler[]) {
  return tools.map(tool => vscode.lm.registerTool(tool.name, {
    prepareInvocation(options) {
      const input = options.input as Record<string, unknown>
      const target = input.caseUri ? vscode.workspace.asRelativePath(vscode.Uri.parse(String(input.caseUri))) : input.simulationId
      return {
        invocationMessage: tool.message,
        ...(!tool.readOnly ? { confirmationMessages: {
          title: tool.message,
          message: new vscode.MarkdownString(tool.capability === 'edit'
            ? `Apply ${(input.changes as unknown[] | undefined)?.length ?? 0} case changes to **${target}** as one undoable edit?`
            : tool.capability === 'simulate'
              ? `${tool.message} for **${target}**${input.program ? ` using ${input.program}` : ''}?`
              : `${tool.message} in the GridKit Studio views?`),
        } } : {}),
      }
    },
    async invoke(options, token) {
      let result: Record<string, unknown>
      try { result = await cancellable(token, signal => tool.run(options.input, signal)) }
      catch (error) { result = { error: toolProblem(error, token.isCancellationRequested) } }
      return toolResult(result, token, options.tokenizationOptions)
    },
  }))
}
