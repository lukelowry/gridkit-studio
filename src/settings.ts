import * as vscode from 'vscode'

import { defaults, definitions, type SettingsValues, validateSettings } from './preferences.js'
export function settingsFor(uri: vscode.Uri): SettingsValues {
  const configuration = vscode.workspace.getConfiguration('gridkitStudio', uri)
  const result = { ...defaults }
  for (const { id } of definitions) {
    const value = configuration.get(id)
    if (value === undefined) continue
    try {
      Object.assign(result, validateSettings({ [id]: value }))
    } catch {
      /* Keep a valid default while settings are being edited. */
    }
  }
  return result
}
