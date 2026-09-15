import * as vscode from 'vscode'

import type { Cases, ReadyCase } from './case.js'
import { describe } from './errors.js'
import { record, type Target, targetOf } from './targets.js'

/** Explorer and editor menus pass the resource; palette invocations pass nothing. */
export const uriOf = (argument: unknown): vscode.Uri | undefined =>
  record(argument) && typeof argument.path === 'string'
    ? (argument as unknown as vscode.Uri)
    : undefined

export function report(error: unknown): void {
  void vscode.window.showErrorMessage(`GridKit Studio: ${describe(error)}`)
}

export function command(
  context: vscode.ExtensionContext,
  id: string,
  action: (argument: unknown) => unknown,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(`gridkitStudio.${id}`, async (argument) => {
      try {
        return await action(argument)
      } catch (error) {
        report(error)
      }
    }),
  )
}

/** Resolves the argument's target, else the active case. Errors on a stale target stay silent. */
export function caseCommand(
  context: vscode.ExtensionContext,
  cases: Cases,
  id: string,
  action: (state: ReadyCase, target: Target, argument: unknown) => unknown,
): void {
  command(context, id, async (argument) => {
    const target = targetOf(argument) ?? cases.active?.target
    const state = target && cases.resolve(target)
    if (!target || !state) return
    try {
      return await action(state, target, argument)
    } catch (error) {
      if (state.current(target)) report(error)
    }
  })
}
