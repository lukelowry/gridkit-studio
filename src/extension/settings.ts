/** What Studio reads of VS Code's settings: where GridKit runs, how much of its results stay read,
 *  and how each view looks. package.json declares each setting and holds its one default. */

import { dirname, resolve } from 'node:path'

import * as vscode from 'vscode'

import { PREFIX } from '../shared/ids.js'
import type { GridKit } from '../shared/messages.js'
import {
  defaults,
  definitions,
  type SettingsValues,
  validateSettings,
} from '../shared/preferences.js'

/** The settings Studio reads besides how its views look, by id. */
interface Runtime {
  readonly gridkitPath: string
  readonly gridkitImage: string
  readonly containerCli: string
  readonly resultCacheMiB: number
}

const MIB = 1 << 20

/** The setting `id` for `scope`, or its default. */
const setting = <K extends keyof Runtime>(id: K, scope?: vscode.Uri): Runtime[K] =>
  vscode.workspace.getConfiguration(PREFIX, scope).get<Runtime[K]>(id)!

/** Whether `event` changes Studio's setting `id`, or any of them, for `scope`. */
export const affects = (
  event: vscode.ConfigurationChangeEvent,
  scope?: vscode.Uri,
  id?: keyof Runtime,
) => event.affectsConfiguration(id ? `${PREFIX}.${id}` : PREFIX, scope)

/** The GridKit the settings name for the case at `uri`; a relative path resolves against its
 *  workspace folder. */
export function gridkitOf(uri: vscode.Uri): GridKit {
  const path = setting('gridkitPath', uri).trim()
  return {
    path: path
      ? resolve(vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? dirname(uri.fsPath), path)
      : '',
    image: setting('gridkitImage', uri).trim(),
    cli: setting('containerCli', uri).trim(),
  }
}

/** How many bytes of decoded results the results worker keeps read past what views read now. It
 *  only paces what stays decoded, so any value works: one that is not a number keeps the default,
 *  and a negative one keeps nothing. */
export function cacheBytes(): number {
  const mib = Number(setting('resultCacheMiB'))
  const fallback = Number(
    vscode.workspace.getConfiguration(PREFIX).inspect('resultCacheMiB')?.defaultValue,
  )
  return Math.max(0, Number.isFinite(mib) ? mib : fallback) * MIB
}

/** How the views of the case at `uri` look; a value that is not valid keeps its default. */
export function displayOf(uri: vscode.Uri): SettingsValues {
  const configuration = vscode.workspace.getConfiguration(PREFIX, uri)
  const result = { ...defaults }
  for (const { id } of definitions) {
    const value = configuration.get(id)
    if (value === undefined) continue
    try {
      Object.assign(result, validateSettings({ [id]: value }))
    } catch {
      // The user may be mid-edit.
    }
  }
  return result
}

/** The choices of the display setting `id`, as its definition names them. */
export function choicesOf(id: keyof SettingsValues): { label: string; value: unknown }[] {
  const definition = definitions.find((each) => each.id === id)
  return definition && 'options' in definition ? [...definition.options] : []
}

/** Sets the display setting `id` for the case at `uri`: in its workspace when one is open, else for
 *  the user. */
export function choose(id: keyof SettingsValues, value: unknown, uri: vscode.Uri) {
  return vscode.workspace
    .getConfiguration(PREFIX, uri)
    .update(
      id,
      value,
      vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global,
    )
}
