import * as vscode from 'vscode'

import { problem } from '../../shared/ai.js'
import type { ToolCapability } from '../../shared/tools.js'

export type AccessLevel = 'inspect' | 'simulate' | 'edit'
/** A local user choice, never repository configuration or model-supplied input. */
export class Access {
  constructor(readonly context: vscode.ExtensionContext) {}
  get level(): AccessLevel { return this.context.workspaceState.get<AccessLevel>('mcp.access', 'inspect') }
  require(capability: ToolCapability) {
    if (capability === 'inspect' || capability === 'display') return
    if (this.level === 'edit' || (capability === 'simulate' && this.level === 'simulate')) return
    throw problem('capability-disabled', `This workspace permits ${this.level} access. Use GridKit Studio: AI Access to enable ${capability === 'edit' ? 'case editing' : 'simulation'} once.`)
  }
  async choose() {
    const choice = await vscode.window.showQuickPick([
      { label: 'Edit and simulate', description: 'Case changes, simulations, analysis and display', value: 'edit' as const },
      { label: 'Simulate', description: 'Simulations, analysis and display; no case edits', value: 'simulate' as const },
      { label: 'Inspect', description: 'Case inspection, retained results, analysis and display', value: 'inspect' as const },
    ], { title: 'GridKit AI access for this workspace', placeHolder: 'Your AI client still controls approval of individual tool calls.' })
    if (!choice) return false
    await this.context.workspaceState.update('mcp.access', choice.value)
    return true
  }
  async configure() {
    if (this.context.workspaceState.get('mcp.access') !== undefined) return true
    return this.choose()
  }
}
