import * as vscode from 'vscode'

import type { Cases } from './case.js'
export function caseContext(cases: Cases): vscode.Disposable {
  let subscription: vscode.Disposable | undefined
  const previous = new Map<string, boolean>()
  const update = () => {
    const state = cases.active
    for (const [key, value] of Object.entries({
      hasCase: !!state?.fields,
      hasRun: !!state?.run || !!state?.source,
      running: state?.run?.status === 'running',
      hasSamples: !!state?.source?.info?.rows,
      playing: !!state?.timeline.playing,
      following: !!state?.timeline.follow,
      looping: !!state?.timeline.loop,
    })) {
      if (previous.get(key) === value) continue
      previous.set(key, value)
      void vscode.commands.executeCommand('setContext', `gridkitStudio.${key}`, value)
    }
  }
  const activate = () => {
    subscription?.dispose()
    subscription = cases.active?.onDidChange(update)
    update()
  }
  const activated = cases.onDidActivate(activate)
  activate()
  return {
    dispose() {
      subscription?.dispose()
      activated.dispose()
    },
  }
}
