/** Reads Studio's VS Code settings. src/shared/settings.ts defines each setting and its default. */

import * as vscode from 'vscode'

import { PROGRAM } from '../gridkit/index.js'
import { dirname, resolve } from '../platform/path.js'
import { PREFIX } from '../shared/ids.js'
import type { GridKit } from '../shared/messages.js'
import {
  defaults,
  type DisplaySettings,
  exportDefaults,
  type ExportSettings,
  nearest,
  SETTINGS,
  type Settings,
  validateSettings,
  type ViewSettings,
} from '../shared/settings.js'

const MIB = 1 << 20

export const setting = <K extends keyof Settings>(id: K, scope?: vscode.Uri): Settings[K] =>
  vscode.workspace.getConfiguration(PREFIX, scope).get<Settings[K]>(id)!

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
      'GridKit Path needs a desktop or remote workspace. Clear it to use the included solver.',
    )
  return {
    program: path ? setting('gridkitProgram', uri).trim() || PROGRAM : PROGRAM,
    path: path
      ? resolve(vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? dirname(uri.fsPath), path)
      : '',
  }
}

/** Bytes of unshown results the worker keeps open. Any value is accepted: a non-number uses the
 *  default and a negative one keeps nothing. */
export function cacheBytes(): number {
  const mib = Number(setting('resultCacheMiB'))
  return Math.max(0, Number.isFinite(mib) ? mib : SETTINGS.resultCacheMiB.default) * MIB
}

/** Sets `id` at the most specific level that defines it, else in user settings. */
export async function setDisplay<K extends keyof DisplaySettings>(
  uri: vscode.Uri,
  id: K,
  value: DisplaySettings[K],
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

/** The settings for `uri` with the keys of `base`. Out-of-range numbers are clamped, and invalid
 *  values keep the default (the user may be mid-edit, and the Settings editor flags them). */
function valuesOf<T extends object>(uri: vscode.Uri, base: Readonly<T>): T {
  const configuration = vscode.workspace.getConfiguration(PREFIX, uri)
  const result = { ...base }
  for (const id of Object.keys(base)) {
    const value = configuration.get(id)
    if (value === undefined) continue
    try {
      Object.assign(result, validateSettings({ [id]: nearest(id, value) }))
    } catch {}
  }
  return result
}

/** How the Network and the Monitor draw the case at `uri`. */
export const displayOf = (uri: vscode.Uri): ViewSettings => valuesOf(uri, defaults)

/** How videos and pictures of the case at `uri` are made. */
export const exportOf = (uri: vscode.Uri): ExportSettings => valuesOf(uri, exportDefaults)
