import { join } from 'node:path'

import * as vscode from 'vscode'

import { problem } from '../../shared/ai.js'
import { validateInput } from '../../shared/tool-validation.js'
import { toolDefinitions } from '../../shared/tools.js'
import { Analyses } from '../analyses.js'
import { Requests } from '../requests.js'
import type { Sessions } from '../sessions.js'
import { Simulations } from '../simulations.js'
import type { Tasks } from '../tasks.js'
import { caseTools } from './case-tools.js'
import { type Register, type ToolHandler, withCaseLeases } from './context.js'
import { displayTools } from './display-tools.js'
import { resultTools } from './result-tools.js'
import { simulationTools } from './simulation-tools.js'

export type { ToolHandler } from './context.js'

/** Shared application handlers; native chat and MCP only adapt transport and authorization. */
export function createTools(studio: Sessions, tasks: Tasks) {
  const directory = (studio.context.storageUri ?? studio.context.globalStorageUri).fsPath
  const requests = new Requests(join(directory, 'requests'))
  const analyses = new Analyses(join(directory, 'analyses'), (analysisId, signal) =>
    studio.client.call('findingsPublished', { analysisId }, signal),
  )
  studio.disposables.push(analyses)
  const simulations = new Simulations(studio, tasks, requests)
  const handlers: ToolHandler[] = []
  const register: Register = (name, execute) => {
    const definition = toolDefinitions.find((tool) => tool.name === 'gridkit_' + name)
    if (!definition || handlers.some((handler) => handler.name === definition.name))
      throw new Error('Missing or duplicate GridKit tool: ' + name)
    handlers.push({
      name: definition.name,
      message: definition.displayName,
      capability: definition.capability,
      readOnly: definition.capability === 'inspect',
      async run(input, signal) {
        signal.throwIfAborted()
        if (!vscode.workspace.isTrusted)
          throw problem('workspace-untrusted', 'Trust this workspace before using GridKit tools.')
        validateInput(definition.inputSchema, input)
        return withCaseLeases(studio, () => execute(input as never, signal))
      },
    })
  }
  caseTools(studio, requests, register)
  simulationTools(studio, simulations, register)
  resultTools(studio, analyses, register)
  displayTools(studio, register)
  if (handlers.length !== toolDefinitions.length)
    throw new Error('GridKit tool contracts and handlers differ.')
  return handlers
}
