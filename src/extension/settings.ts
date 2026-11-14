/** What Studio reads of VS Code's settings: how GridKit runs and the classes it has, how much of its
 *  results stay read, and how each view looks. src/shared/settings.ts defines each setting and
 *  holds its one default. */

import * as vscode from 'vscode'

import { PROGRAM } from '../gridkit/index.js'
import { dirname, resolve } from '../platform/path.js'
import { PREFIX } from '../shared/ids.js'
import type { GridKit } from '../shared/messages.js'
import {
  defaults,
  SETTINGS,
  type Settings,
  validateSettings,
  type ViewSettings,
} from '../shared/settings.js'

const MIB = 1 << 20

/** The setting `id` for `scope`, or its default. */
export const setting = <K extends keyof Settings>(id: K, scope?: vscode.Uri): Settings[K] =>
  vscode.workspace.getConfiguration(PREFIX, scope).get<Settings[K]>(id)!

/** Whether `event` changes Studio's setting `id`, or any of them, for `scope`. */
export const affects = (
  event: vscode.ConfigurationChangeEvent,
  scope?: vscode.Uri,
  id?: keyof Settings,
) => event.affectsConfiguration(id ? `${PREFIX}.${id}` : PREFIX, scope)

/** Empty selects bundled WASM; an explicit native path resolves on the workspace host. */
export function gridkitOf(uri: vscode.Uri): GridKit {
  const path = setting('gridkitPath', uri).trim()
  if (path && uri.scheme !== 'file')
    throw new Error(
      'GridKit Path requires files on a desktop or remote machine. Clear it to use the included solver.',
    )
  return {
    program: path ? setting('gridkitProgram', uri).trim() || PROGRAM : PROGRAM,
    path: path
      ? resolve(vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? dirname(uri.fsPath), path)
      : '',
  }
}

/** How many bytes of results no view shows the worker keeps open. It only paces what stays
 *  open, so any value works: one that is not a number keeps the default, and a negative one keeps
 *  nothing. */
export function cacheBytes(): number {
  const mib = Number(setting('resultCacheMiB'))
  return Math.max(0, Number.isFinite(mib) ? mib : SETTINGS.resultCacheMiB.default) * MIB
}

/** Sets how the views of the case at `uri` look, `id` to `value`, where it takes effect: in the
 *  most specific place that sets it now, else for the user. */
export async function setDisplay<K extends keyof ViewSettings>(
  uri: vscode.Uri,
  id: K,
  value: ViewSettings[K],
): Promise<void> {
  const configuration = vscode.workspace.getConfiguration(PREFIX, uri)
  const set = configuration.inspect(id)
  const target =
    set?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : set?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global
  await configuration.update(id, value, target)
}

/** How the views of the case at `uri` look; a value that is not valid keeps its default. */
export function displayOf(uri: vscode.Uri): ViewSettings {
  const configuration = vscode.workspace.getConfiguration(PREFIX, uri)
  const result = { ...defaults }
  for (const id of Object.keys(defaults)) {
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
