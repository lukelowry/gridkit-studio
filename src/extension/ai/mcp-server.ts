/** Loaded from its own bundle only after a local client authenticates. */
import type { Socket } from 'node:net'

import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'

import { toolProblem } from '../../shared/ai.js'
import { toolDefinitions } from '../../shared/tools.js'
import { boundedResult } from './output.js'
import type { ToolHandler } from './tools.js'

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
      output: fromJsonSchema((toolDefinitions.find(tool => tool.name === definition.name)?.outputSchema ?? { type: 'object' }) as Parameters<typeof fromJsonSchema>[0]),
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
              'Start with list_cases and describe_case; editors need not be open. Use explicit caseUri and caseRevision for edits, simulationId for recordings, and analysisId for progress and findings. simulate and edit_case act directly within workspace AI access; there are no proposal tabs. Reuse a requestId only for an identical retry. An uncertain edit outcome must be inspected before new work. ContingencyAnalysis is a bus-fault study. Analyze original recorded samples; envelopes are only for display. Completed recordings and findings survive reload subject to retention.',
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
                const problem = toolProblem(error, context.mcpReq.signal.aborted)
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
