/** Loaded from its own bundle only after a local client authenticates. */
import type { Socket } from 'node:net'

import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'

import { message } from '../shared/format.js'
import { boundedResult } from './ai-output.js'
import { outputSchemas } from './ai-schemas.js'
import type { ToolHandler } from './ai-tools.js'

export interface ToolDefinition {
  name: string
  displayName: string
  modelDescription: string
  inputSchema: Parameters<typeof fromJsonSchema>[0]
}

/** Schemas are shared; protocol state belongs to each connection. */
export function createAdapter(
  handlers: readonly ToolHandler[],
  definitions: readonly ToolDefinition[],
  version: string,
  initialized?: (socket: Socket, client: { name: string; version: string }) => void,
) {
  const catalog = definitions.map((definition) => {
    const handler = handlers.find((handler) => handler.name === definition.name)
    if (!handler) throw new Error('No handler for ' + definition.name)
    return {
      definition,
      handler,
      schema: fromJsonSchema(definition.inputSchema),
      output: fromJsonSchema(outputSchemas[definition.name] ?? { type: 'object' }),
    }
  })
  if (
    catalog.length !== handlers.length ||
    new Set(definitions.map((tool) => tool.name)).size !== handlers.length
  )
    throw new Error('GridKit tool contributions and handlers differ.')
  return (socket: Socket) => {
    // A message may be as large as the client sends: the SDK otherwise refuses one past 10 MiB.
    const transport = new StdioServerTransport(socket, socket, { maxBufferSize: Infinity })
    const close = transport.close.bind(transport)
    transport.close = async () => {
      try {
        await close()
      } finally {
        socket.destroy()
      }
    }
    return serveStdio(
      () => {
        const server = new McpServer(
          { name: 'gridkit-studio', version },
          {
            instructions:
              'Inspect open cases first. Use explicit case URIs, document revisions and run IDs. Analyze recorded signals in the worker. Edit and run tools open a preview in VS Code and require the user to act there. A pending preview is not an applied edit or a started run. Check action_status for the outcome. Never automatically retry a mutation after disconnect.',
          },
        )
        server.server.oninitialized = () => {
          const client = server.server.getClientVersion()
          if (client) initialized?.(socket, client)
        }
        for (const { definition, handler, schema, output } of catalog) {
          server.registerTool(
            definition.name,
            {
              title: definition.displayName,
              description: definition.modelDescription,
              inputSchema: schema,
              outputSchema: output,
              annotations: { readOnlyHint: handler.readOnly, openWorldHint: false },
            },
            async (input, context) => {
              try {
                const signal = context.mcpReq.signal
                const output = await handler.run(input, signal)
                const { result, text } = await boundedResult(output, () => signal.throwIfAborted())
                return { structuredContent: result, content: [{ type: 'text', text }] }
              } catch (error) {
                const code =
                  typeof (error as { code?: unknown } | null)?.code === 'string'
                    ? (error as { code: string }).code
                    : context.mcpReq.signal.aborted
                      ? 'cancelled'
                      : 'operation-failed'
                const problem = { code, message: message(error) }
                return {
                  isError: true,
                  structuredContent: { error: problem },
                  content: [{ type: 'text', text: JSON.stringify({ error: problem }) }],
                }
              }
            },
          )
        }
        return server
      },
      {
        transport,
        onerror: () => socket.destroy(),
        maxSubscriptions: 0,
      },
    )
  }
}
