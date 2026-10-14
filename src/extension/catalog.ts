/** The catalog of GridKit's classes the Catalog setting names, which the workers read in place of
 *  the bundled one as they start. */

import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import * as vscode from 'vscode'

import { catalogOf } from '../gridkit/index.js'
import { message } from '../shared/errors.js'
import { setting } from './settings.js'

/** The catalog the setting names, checked as the workers read it: none when it names none, or when
 *  the file does not read, which `report` hears. A relative path resolves against the first
 *  workspace folder. */
export function catalogFile(report: (error: unknown) => void): unknown {
  const path = setting('catalog').trim()
  if (!path) return undefined
  const file = resolve(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', path)
  try {
    const json: unknown = JSON.parse(readFileSync(file, 'utf8'))
    catalogOf(json)
    return json
  } catch (error) {
    report(
      new Error(`${basename(file)} is not a catalog GridKit Studio can read: ${message(error)}`),
    )
    return undefined
  }
}
