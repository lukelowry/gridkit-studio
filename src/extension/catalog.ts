/** The catalog of GridKit's classes the Catalog setting names, which the worker reads in place of
 *  the bundled one as it starts. */

import * as vscode from 'vscode'

import { catalogOf } from '../gridkit/index.js'
import { readFile } from '../platform/files.js'
import { basename, resolve } from '../platform/path.js'
import { message } from '../shared/errors.js'
import { setting } from './settings.js'
import { reference } from './uris.js'

/** The catalog the setting names, checked as the worker reads it: none when it names none, or when
 *  the file does not read, which `report` hears. A relative path resolves against the first
 *  workspace folder. */
export async function catalogFile(report: (error: unknown) => void): Promise<unknown> {
  const path = setting('catalog').trim()
  if (!path) return undefined
  const file = resolve(
    vscode.workspace.workspaceFolders?.[0]
      ? reference(vscode.workspace.workspaceFolders[0].uri)
      : '',
    path,
  )
  try {
    const json: unknown = JSON.parse(await readFile(file, 'utf8'))
    catalogOf(json)
    return json
  } catch (error) {
    report(
      new Error(`${basename(file)} is not a catalog GridKit Studio can read: ${message(error)}`),
    )
    return undefined
  }
}
