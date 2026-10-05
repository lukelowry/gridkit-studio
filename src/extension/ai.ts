import * as vscode from 'vscode'

import { toolResult } from './ai-output.js'
import { createTools } from './ai-tools.js'
import { cancellable } from './client.js'
import { MCP } from './mcp.js'
import { Proposals } from './proposals.js'
import type { Sessions } from './sessions.js'
import type { Tasks } from './tasks.js'

export function registerAI(studio: Sessions, tasks: Tasks) {
  const proposals = new Proposals(studio, tasks)
  const tools = createTools(studio, proposals)
  const contributed = studio.context.extension.packageJSON.contributes.languageModelTools as {
    name: string
  }[]
  if (
    contributed.length !== tools.length ||
    tools.some((tool) => contributed.filter((item) => item.name === tool.name).length !== 1)
  )
    throw new Error('GridKit tool contributions and handlers differ.')
  const registrations = tools.map((tool) =>
    vscode.lm.registerTool(tool.name, {
      prepareInvocation: () => ({ invocationMessage: tool.message }),
      async invoke(options, token) {
        const result = await cancellable(token, (signal) => tool.run(options.input, signal))
        return toolResult(result, token, options.tokenizationOptions)
      },
    }),
  )
  const mcp = new MCP(studio, tools)
  let disposal: Promise<void> | undefined
  return {
    mcp,
    dispose() {
      return (disposal ??= (async () => {
        await mcp.dispose()
        for (const registration of registrations) registration.dispose()
        proposals.dispose()
      })())
    },
  }
}
