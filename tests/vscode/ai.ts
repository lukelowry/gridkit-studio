/** Native language-model contract without model credentials. */
import assert from 'node:assert/strict'

import * as vscode from 'vscode'

import { exerciseTools, type Call } from './ai-contract.js'
import { extension } from './harness.js'

export async function run() {
  const { studio } = await extension().activate()
  assert.equal(vscode.lm.tools.filter(tool => tool.name.startsWith('gridkit_')).length, 20)
  const call: Call = async (name, input) => {
    const result = await vscode.lm.invokeTool('gridkit_' + name, { input, toolInvocationToken: undefined })
    const value = JSON.parse(result.content.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => part.value).join(''))
    if (value.error) throw new Error(JSON.stringify(value.error))
    return value
  }
  await exerciseTools(studio, call)
  assert.deepEqual(studio.errors.splice(0), [])
  console.log('Native AI: discovery, schemas, atomic edits and undo, idempotency, analysis metrics, samples and plots verified.')
}
