import { createTools } from './tools.js'
import { MCP } from './mcp.js'
import { registerNative } from './native.js'
import type { Sessions } from '../sessions.js'
import type { Tasks } from '../tasks.js'

export function registerAI(studio: Sessions, tasks: Tasks) {
  const tools = createTools(studio, tasks)
  const contributed = studio.context.extension.packageJSON.contributes.languageModelTools as {
    name: string
  }[]
  if (
    contributed.length !== tools.length ||
    tools.some((tool) => contributed.filter((item) => item.name === tool.name).length !== 1)
  )
    throw new Error('GridKit tool contributions and handlers differ.')
  const registrations = registerNative(tools)
  const mcp = new MCP(studio, tools)
  let disposal: Promise<void> | undefined
  return {
    mcp,
    dispose() {
      return (disposal ??= (async () => {
        await mcp.dispose()
        for (const registration of registrations) registration.dispose()
      })())
    },
  }
}
